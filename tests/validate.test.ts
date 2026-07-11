/**
 * Tests for src/model/validate.ts (layout validator) and the curated LLM
 * few-shot examples. Owned by the tests agent.
 *
 * The validator result is normalized leniently (SimIssue[] | {issues} |
 * {errors, warnings}) — see contractRequests: the suggested canonical shape
 * is `validateLayout(layout: CircuitLayout): SimIssue[]`.
 */
import { describe, expect, it } from 'vitest'
import { validateLayout } from '../src/model/validate'
import { FEW_SHOT_EXAMPLES } from '../src/llm/examples'
import type { CircuitLayout } from '../src/model/types'
import { dip, layout, poweredLayout, twoLead, wire } from './helpers'

type NormIssue = { level: 'error' | 'warning'; message: string }
type RawIssue = { level?: unknown; message?: unknown } | string

function norm(x: RawIssue, fallback: 'error' | 'warning'): NormIssue {
  if (typeof x === 'string') return { level: fallback, message: x }
  const level = x.level === 'warning' ? 'warning' : x.level === 'error' ? 'error' : fallback
  return { level, message: typeof x.message === 'string' ? x.message : JSON.stringify(x) }
}

function issuesOf(res: unknown): NormIssue[] {
  if (Array.isArray(res)) return res.map((x) => norm(x as RawIssue, 'error'))
  if (res && typeof res === 'object') {
    const o = res as Record<string, unknown>
    if (Array.isArray(o.issues)) return o.issues.map((x) => norm(x as RawIssue, 'error'))
    const out: NormIssue[] = []
    if (Array.isArray(o.errors)) out.push(...o.errors.map((x) => norm(x as RawIssue, 'error')))
    if (Array.isArray(o.warnings))
      out.push(...o.warnings.map((x) => norm(x as RawIssue, 'warning')))
    if (Array.isArray(o.errors) || Array.isArray(o.warnings)) return out
  }
  throw new Error(`unrecognized validateLayout() result shape: ${JSON.stringify(res)}`)
}

const errorsIn = (l: CircuitLayout) =>
  issuesOf(validateLayout(l)).filter((i) => i.level === 'error')
const warningsIn = (l: CircuitLayout) =>
  issuesOf(validateLayout(l)).filter((i) => i.level === 'warning')

/** A small, fully valid circuit: 5V supply → 330Ω → LED → ground. */
function validBase(): CircuitLayout {
  return poweredLayout(
    [
      twoLead('R1', 'resistor', 'top+1', 'a10', { resistance: 330 }),
      twoLead('D1', 'led', 'b10', 'top-1', { color: 'red' }),
    ],
    [],
  )
}

describe('validateLayout', () => {
  it('passes a valid layout with zero errors', () => {
    const errs = errorsIn(validBase())
    expect(errs, JSON.stringify(errs)).toEqual([])
  })

  it('rejects an unknown component type', () => {
    const l = validBase()
    l.components.push({ id: 'X1', type: 'warp_core', holes: ['a20', 'a21'] })
    expect(errorsIn(l).length).toBeGreaterThanOrEqual(1)
  })

  it('rejects duplicate component ids', () => {
    const l = validBase()
    l.components.push(twoLead('R1', 'resistor', 'a20', 'a25', { resistance: 1000 }))
    expect(errorsIn(l).length).toBeGreaterThanOrEqual(1)
  })

  it('rejects bad hole refs', () => {
    const l1 = validBase()
    l1.components.push(twoLead('R2', 'resistor', 'a64', 'a20'))
    expect(errorsIn(l1).length).toBeGreaterThanOrEqual(1)

    const l2 = validBase()
    l2.components.push(twoLead('R2', 'resistor', 'k5', 'a20'))
    expect(errorsIn(l2).length).toBeGreaterThanOrEqual(1)
  })

  it('rejects a wrong holes[] length', () => {
    const l = validBase()
    l.components.push({ id: 'R2', type: 'resistor', holes: ['a20'] })
    expect(errorsIn(l).length).toBeGreaterThanOrEqual(1)

    const l2 = validBase()
    l2.components.push({ id: 'R3', type: 'resistor', holes: ['a20', 'a21', 'a22'] })
    expect(errorsIn(l2).length).toBeGreaterThanOrEqual(1)
  })

  it('rejects a DIP anchored off row f', () => {
    const l = validBase()
    l.components.push(dip('U1', 'ne555', 'e20'))
    expect(errorsIn(l).length).toBeGreaterThanOrEqual(1)
  })

  it('rejects a DIP that runs off the right edge', () => {
    const l = validBase()
    l.components.push(dip('U1', 'ne555', 'f61')) // needs cols 61..64
    expect(errorsIn(l).length).toBeGreaterThanOrEqual(1)
  })

  it('rejects two pins in one hole (occupancy)', () => {
    const l = validBase()
    // a10 is already taken by R1's second lead
    l.components.push(twoLead('R2', 'resistor', 'a10', 'a20', { resistance: 1000 }))
    expect(errorsIn(l).length).toBeGreaterThanOrEqual(1)
  })

  it('rejects wires to nonexistent endpoints', () => {
    const l1 = validBase()
    l1.wires.push(wire('PS2:+', 'a20')) // no component PS2
    expect(errorsIn(l1).length).toBeGreaterThanOrEqual(1)

    const l2 = validBase()
    l2.wires.push(wire('PS1:x', 'a20')) // PS1 has no pin "x"
    expect(errorsIn(l2).length).toBeGreaterThanOrEqual(1)

    const l3 = validBase()
    l3.wires.push(wire('a99', 'a20')) // parses (Lab XL syntax) but off the standard board
    expect(errorsIn(l3).length).toBeGreaterThanOrEqual(1)

    const l4 = validBase()
    l4.wires.push(wire('a999', 'a20')) // unparseable hole (beyond every preset)
    expect(errorsIn(l4).length).toBeGreaterThanOrEqual(1)
  })

  it('rejects bad param values / unknown params', () => {
    const l1 = validBase()
    l1.components.push(twoLead('R2', 'resistor', 'a20', 'a25', { resistance: 'high' }))
    expect(errorsIn(l1).length).toBeGreaterThanOrEqual(1)

    const l2 = validBase()
    l2.components.push(twoLead('R3', 'resistor', 'a20', 'a25', { frobnicate: 1 }))
    expect(errorsIn(l2).length).toBeGreaterThanOrEqual(1)
  })

  it('missing power supply is a warning, not an error', () => {
    const l = layout([twoLead('R1', 'resistor', 'a1', 'b5', { resistance: 1000 })], [])
    expect(errorsIn(l)).toEqual([])
    expect(warningsIn(l).length).toBeGreaterThanOrEqual(1)
  })
})

describe('LLM few-shot examples', () => {
  it('every FEW_SHOT_EXAMPLES layout validates with zero errors', () => {
    expect(Array.isArray(FEW_SHOT_EXAMPLES)).toBe(true)
    expect(FEW_SHOT_EXAMPLES.length).toBeGreaterThanOrEqual(1)
    for (const ex of FEW_SHOT_EXAMPLES as unknown[]) {
      const l = (
        ex && typeof ex === 'object' && 'components' in (ex as object)
          ? ex
          : (ex as { layout?: unknown }).layout
      ) as CircuitLayout
      expect(l, 'example must be a CircuitLayout or carry a .layout').toBeTruthy()
      expect(Array.isArray(l.components)).toBe(true)
      const errs = errorsIn(l)
      expect(errs, `${l.name ?? 'example'}: ${JSON.stringify(errs)}`).toEqual([])
    }
  })
})
