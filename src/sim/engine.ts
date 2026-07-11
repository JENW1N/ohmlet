/**
 * The simulation engine: nets + analog devices + behavioral chips.
 * Owned by the sim-core agent.
 *
 * Step order (per ARCHITECTURE.md):
 *   1. chips step    — read PREVIOUS solution, declare per-pin Norton drives
 *   2. device beginStep — companion-model updates (BE capacitor/inductor…)
 *   3. solve         — single pass for linear circuits, Newton-Raphson else
 *   4. device endStep — state + telemetry bookkeeping, runtime issue checks
 *
 * The engine never throws on weird layouts: malformed components are
 * excluded and reported as issues instead.
 */

import '../model/catalog'
import './chips/all' // side-effect: registers every behavioral chip model

import type {
  BoardConfig,
  CircuitLayout,
  ComponentInstance,
  ComponentTelemetry,
  EndpointRef,
  ParamValue,
  SimIssue,
  SimTelemetry,
} from '../model/types'
import { isBoardCount, isBoardSizeId } from '../model/types'
import { componentPinHoles, formatHole } from '../model/breadboard'
import { getEntry } from '../model/catalog'
import type { CatalogEntry } from '../model/catalog'
import { createChip } from './chip-api'
import type { ChipInstance, ChipStepCtx, PinDrive } from './chip-api'
import { buildNetlist } from './netlist'
import type { Netlist } from './netlist'
import { MnaSystem, solveNewton } from './mna'
import { createDevice, LedDevice, PowerSupplyDevice } from './devices'
import type { AnalogDevice } from './devices'

/** Default simulation time step (seconds). */
export const DEFAULT_DT = 5e-5

/** Node index meaning "this pin maps to no net" (ground is -1). */
const NO_NET = -2

const MSG_NO_POWER = 'no power supply'
const MSG_SINGULAR = 'circuit matrix is singular — check connections'
const MSG_NO_CONVERGE = 'solver failed to converge — results may be inaccurate'
const MSG_NUMERIC = 'numerical error in solver — voltages were reset'

// --------------------------------------------------------- chip plumbing

class ChipRuntime {
  readonly pinIndex = new Map<string, number>()
  readonly pinNodes: Int32Array
  readonly driveG: Float64Array // 0 = pin released (high-impedance)
  readonly driveV: Float64Array
  readonly ctx: ChipCtx
  readonly supplyPinIdx: number
  readonly supplyPinName: string

  constructor(
    readonly comp: ComponentInstance,
    readonly entry: CatalogEntry,
    readonly chip: ChipInstance,
    nodes: number[],
    x: Float64Array,
  ) {
    const n = entry.pins.length
    this.pinNodes = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      this.pinNodes[i] = i < nodes.length ? nodes[i] : NO_NET
      this.pinIndex.set(entry.pins[i], i)
    }
    this.driveG = new Float64Array(n)
    this.driveV = new Float64Array(n)
    const supply = entry.pins.findIndex((p) => p === 'VCC' || p === 'VDD')
    this.supplyPinIdx = supply
    this.supplyPinName = supply >= 0 ? entry.pins[supply] : ''
    this.ctx = new ChipCtx(this, x)
  }
}

class ChipCtx implements ChipStepCtx {
  time = 0
  dt = DEFAULT_DT

  constructor(
    private readonly rt: ChipRuntime,
    private readonly x: Float64Array,
  ) {}

  readPin(pin: string): number {
    const i = this.rt.pinIndex.get(pin)
    if (i === undefined) return NaN
    const node = this.rt.pinNodes[i]
    if (node <= NO_NET) return NaN
    return node < 0 ? 0 : this.x[node]
  }

  drivePin(pin: string, drive: PinDrive | null): void {
    const i = this.rt.pinIndex.get(pin)
    if (i === undefined) return
    if (!drive) {
      this.rt.driveG[i] = 0
      return
    }
    const rout = drive.rout > 1e-3 ? drive.rout : 1e-3
    this.rt.driveG[i] = 1 / rout
    this.rt.driveV[i] = drive.v
  }
}

// ------------------------------------------------------ per-component info

interface CompRuntime {
  comp: ComponentInstance
  entry: CatalogEntry | null
  /** node index per catalog pin (-1 ground, NO_NET unmapped); null = excluded */
  pinNodes: number[] | null
  device: AnalogDevice | null
  chip: ChipRuntime | null
}

// ------------------------------------------------------------------ engine

export class SimEngine {
  /** Static + runtime issues, deduplicated by message. */
  readonly issues: SimIssue[] = []
  time = 0

  private readonly netlist: Netlist
  private readonly board: BoardConfig
  private readonly netIndex = new Map<string, number>()
  private readonly sys: MnaSystem
  private readonly x: Float64Array
  private readonly runtimes: CompRuntime[] = []
  private readonly devices: AnalogDevice[] = []
  private readonly chips: ChipRuntime[] = []
  private readonly deviceById = new Map<string, AnalogDevice>()
  private readonly leds: LedDevice[] = []
  private readonly supplies: PowerSupplyDevice[] = []
  private readonly ledReported: Uint8Array
  private readonly supplyWarned: Uint8Array
  private readonly isLinear: boolean
  private readonly issueKeys = new Set<string>()
  private readonly stampAllFn: (xv: Float64Array) => void
  private firstSolveDone = false

  constructor(layout: CircuitLayout) {
    // boardConfigOf(layout), hardened: never throw on weird layouts.
    this.board = {
      size: isBoardSizeId(layout?.board) ? layout.board : 'standard',
      count: isBoardCount(layout?.boardCount) ? layout.boardCount : 1,
    }
    this.netlist = buildNetlist(layout)
    for (const w of this.netlist.warnings) this.addIssue('warning', w)

    // map every non-ground net to a solver node index
    let n = 0
    for (const net of this.netlist.nets) {
      if (net !== this.netlist.ground) this.netIndex.set(net, n++)
    }
    this.sys = new MnaSystem(n)
    this.x = new Float64Array(n)
    this.stampAllFn = (xv: Float64Array) => this.stampAll(xv)

    const components: ComponentInstance[] = Array.isArray(layout?.components)
      ? layout.components
      : []
    let hasSupply = false

    for (const comp of components) {
      const rt: CompRuntime = { comp, entry: null, pinNodes: null, device: null, chip: null }
      this.runtimes.push(rt)
      try {
        if (!comp || typeof comp.id !== 'string' || typeof comp.type !== 'string') {
          this.addIssue('error', 'component with missing id/type — excluded from simulation')
          continue
        }
        const entry = getEntry(comp.type)
        if (!entry) {
          this.addIssue(
            'error',
            `component ${comp.id} has unknown type "${comp.type}" — excluded from simulation`,
            comp.id,
          )
          continue
        }
        rt.entry = entry
        if (comp.type === 'power_supply') hasSupply = true

        const nodes = this.resolvePinNodes(comp, entry)
        if (!nodes) {
          this.addIssue(
            'error',
            `component ${comp.id} is malformed (bad holes or anchor) — excluded from simulation`,
            comp.id,
          )
          continue
        }
        rt.pinNodes = nodes

        const sim = entry.sim
        if (sim.kind === 'device') {
          const device = createDevice(sim.model, comp, entry, nodes)
          if (!device) {
            this.addIssue(
              'error',
              `component ${comp.id}: unknown device model "${sim.model}" — excluded from simulation`,
              comp.id,
            )
            continue
          }
          rt.device = device
          this.devices.push(device)
          this.deviceById.set(comp.id, device)
          if (device instanceof LedDevice) this.leds.push(device)
          if (device instanceof PowerSupplyDevice) this.supplies.push(device)
        } else if (sim.kind === 'chip') {
          const chip = createChip(sim.model, comp)
          if (!chip) {
            this.addIssue(
              'warning',
              `component ${comp.id}: chip model "${sim.model}" is not registered — excluded from simulation`,
              comp.id,
            )
            continue
          }
          const crt = new ChipRuntime(comp, entry, chip, nodes, this.x)
          rt.chip = crt
          this.chips.push(crt)
        }
        // sim.kind === 'probe': no electrical stamp, pin voltages only
      } catch (err) {
        this.addIssue(
          'error',
          `component ${comp?.id ?? '?'} failed to initialize: ${String(err)}`,
          comp?.id,
        )
      }
    }

    if (!hasSupply) this.addIssue('warning', MSG_NO_POWER)

    this.ledReported = new Uint8Array(this.leds.length)
    this.supplyWarned = new Uint8Array(this.supplies.length)

    let linear = true
    for (const d of this.devices) {
      if (d.nonlinear) {
        linear = false
        break
      }
    }
    this.isLinear = linear
  }

  // ------------------------------------------------------------ stepping

  /** Advance the simulation by one step (default DEFAULT_DT seconds). */
  step(dt?: number): void {
    let h = dt ?? DEFAULT_DT
    if (!(h > 0) || !Number.isFinite(h)) h = DEFAULT_DT
    const t = this.time
    const x = this.x

    // 1. chips read the previous solution and declare their drives
    const chips = this.chips
    for (let i = 0; i < chips.length; i++) {
      const c = chips[i]
      c.ctx.time = t
      c.ctx.dt = h
      try {
        c.chip.step(c.ctx)
      } catch (err) {
        this.addIssue('error', `chip ${c.comp.id} model error: ${String(err)}`, c.comp.id)
      }
    }

    // 2. analog companion-model updates
    const devices = this.devices
    for (let i = 0; i < devices.length; i++) devices[i].beginStep(t, h)

    // 3. solve
    if (this.sys.nodeCount > 0) {
      if (this.isLinear) {
        this.sys.beginStamp()
        this.stampAll(x)
        if (this.sys.factorIfNeeded()) this.sys.solveInto(x)
        else this.addIssue('warning', MSG_SINGULAR)
      } else {
        const res = solveNewton(this.sys, this.stampAllFn, x)
        if (res.singular) this.addIssue('warning', MSG_SINGULAR)
        else if (!res.converged) this.addIssue('warning', MSG_NO_CONVERGE)
      }
      // never let NaN/Inf propagate into future steps
      for (let i = 0; i < x.length; i++) {
        if (!Number.isFinite(x[i])) {
          x.fill(0)
          this.addIssue('warning', MSG_NUMERIC)
          break
        }
      }
    }

    // 4. device bookkeeping
    for (let i = 0; i < devices.length; i++) devices[i].endStep(x)

    // runtime issues
    this.checkRuntimeIssues()
    if (!this.firstSolveDone) {
      this.firstSolveDone = true
      this.checkChipSupplies()
    }

    this.time = t + h
  }

  /** Advance by (approximately) `seconds` of simulation time in `dt` steps. */
  advance(seconds: number, dt?: number): void {
    if (!(seconds > 0) || !Number.isFinite(seconds)) return
    let h = dt ?? DEFAULT_DT
    if (!(h > 0) || !Number.isFinite(h)) h = DEFAULT_DT
    const steps = Math.max(1, Math.round(seconds / h))
    for (let i = 0; i < steps; i++) this.step(h)
  }

  // ----------------------------------------------------------- telemetry

  telemetry(): SimTelemetry {
    const netVoltages: Record<string, number> = {}
    const ground = this.netlist.ground
    for (const net of this.netlist.nets) {
      if (net === ground) {
        netVoltages[net] = 0
      } else {
        const idx = this.netIndex.get(net)
        netVoltages[net] = idx === undefined ? NaN : this.x[idx]
      }
    }

    const components: Record<string, ComponentTelemetry> = {}
    for (const rt of this.runtimes) {
      if (!rt.comp || typeof rt.comp.id !== 'string') continue
      const tele: ComponentTelemetry = { pinVoltages: {} }
      if (rt.entry && rt.pinNodes) {
        const pins = rt.entry.pins
        for (let i = 0; i < pins.length; i++) {
          tele.pinVoltages[pins[i]] = this.nodeVoltage(rt.pinNodes[i])
        }
      }
      if (rt.device) {
        try {
          rt.device.fillTelemetry(tele)
        } catch {
          /* never throw from telemetry */
        }
      }
      if (rt.chip && rt.chip.chip.outputs) {
        try {
          const out = rt.chip.chip.outputs()
          if (out) tele.outputs = out
        } catch {
          /* never throw from telemetry */
        }
      }
      components[rt.comp.id] = tele
    }

    return {
      time: this.time,
      netVoltages,
      components,
      issues: this.issues.slice(),
    }
  }

  /** Live tweaks while running: pot position, switch state, pressed, light, voltage… */
  setRuntimeParam(componentId: string, key: string, value: ParamValue): void {
    const device = this.deviceById.get(componentId)
    if (!device) return
    try {
      device.setRuntimeParam(key, value)
    } catch {
      /* never throw on bad runtime params */
    }
  }

  /** Voltage of the net a hole/terminal ref belongs to; NaN if unknown. */
  netVoltage(ref: EndpointRef): number {
    const net = this.netlist.netOf(ref)
    if (!net) return NaN
    if (net === this.netlist.ground) return 0
    const idx = this.netIndex.get(net)
    return idx === undefined ? NaN : this.x[idx]
  }

  // ------------------------------------------------------------ internals

  private nodeVoltage(node: number): number {
    if (node === -1) return 0
    if (node < 0) return NaN
    return this.x[node]
  }

  private resolvePinNodes(comp: ComponentInstance, entry: CatalogEntry): number[] | null {
    if (entry.placement === 'offboard') {
      const out: number[] = []
      for (const pin of entry.pins) {
        out.push(this.nodeOfNet(this.netlist.netOf(`${comp.id}:${pin}`)))
      }
      return out
    }
    const holes = componentPinHoles(comp, entry, this.board)
    if (!holes) return null
    const out: number[] = []
    for (const h of holes) {
      out.push(h ? this.nodeOfNet(this.netlist.netOf(formatHole(h))) : NO_NET)
    }
    return out
  }

  private nodeOfNet(net: string | null): number {
    if (!net) return NO_NET
    if (net === this.netlist.ground) return -1
    const idx = this.netIndex.get(net)
    return idx === undefined ? NO_NET : idx
  }

  /** Stamp every device and every chip pin drive (called per NR iteration). */
  private stampAll(xv: Float64Array): void {
    const sys = this.sys
    const devices = this.devices
    for (let i = 0; i < devices.length; i++) devices[i].stamp(sys, xv)
    const chips = this.chips
    for (let i = 0; i < chips.length; i++) {
      const c = chips[i]
      const pinNodes = c.pinNodes
      const driveG = c.driveG
      const driveV = c.driveV
      for (let p = 0; p < pinNodes.length; p++) {
        const g = driveG[p]
        if (g > 0) {
          const node = pinNodes[p]
          if (node >= 0) {
            // Norton drive between the pin and ground
            sys.addElement(node, node, g)
            sys.addCurrent(node, driveV[p] * g)
          }
          // node === -1 (pin wired to ground): driving ground is a no-op
        }
      }
    }
  }

  private checkRuntimeIssues(): void {
    const leds = this.leds
    for (let i = 0; i < leds.length; i++) {
      if (this.ledReported[i] === 0 && leds[i].burned) {
        this.ledReported[i] = 1
        const led = leds[i]
        this.addIssue(
          'error',
          `LED ${led.comp.id} burned out (current ${Math.round(led.burnCurrentMa)}mA — add a series resistor)`,
          led.comp.id,
        )
      }
    }
    const supplies = this.supplies
    for (let i = 0; i < supplies.length; i++) {
      if (this.supplyWarned[i] === 0 && Math.abs(supplies[i].current) > 2) {
        this.supplyWarned[i] = 1
        this.addIssue(
          'warning',
          `supply ${supplies[i].comp.id} current > 2A (possible short circuit)`,
          supplies[i].comp.id,
        )
      }
    }
  }

  /** One-time check after the first solve: chip supply pins must be powered. */
  private checkChipSupplies(): void {
    for (const c of this.chips) {
      if (c.supplyPinIdx < 0) continue
      const node = c.pinNodes[c.supplyPinIdx]
      const v = node === -1 ? 0 : node >= 0 ? this.x[node] : NaN
      if (!(v >= 2)) {
        this.addIssue(
          'warning',
          `chip ${c.comp.id} ${c.supplyPinName} pin not connected to a powered net`,
          c.comp.id,
        )
      }
    }
  }

  private addIssue(level: 'error' | 'warning', message: string, componentId?: string): void {
    if (this.issueKeys.has(message)) return
    this.issueKeys.add(message)
    const issue: SimIssue = componentId ? { level, message, componentId } : { level, message }
    this.issues.push(issue)
  }
}
