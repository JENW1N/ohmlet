/**
 * MoreSheet — settings / import / export / examples / issues, as iOS inset
 * grouped lists (snap 0.55/0.92).
 *
 * Groups: [Simulation] speed Segmented + Reset row · [Circuit] Import
 * (sub-view: file picker + paste-JSON with inline error list, ported from
 * the old ImportDialog), Export (download + clipboard copy + toast), Clear
 * board (destructive, ActionSheet confirm), Examples (statically imported
 * JSONs — fetch() can't reach repo-root files in dev — one-tap loadLayout
 * with a success toast) · [Issues] live level-colored list (tap selects the
 * component and dismisses) · [Settings] shared ApiKeyRow + About.
 * [Graphics]: render-mode Segmented (Performance/Enhanced/Studio) with a
 * per-mode caption and a device-default badge, backed by the store's
 * renderMode contract.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useStore } from '../../state/store'
import { BOARD_SIZES, boardOf, isBoardRows, MAX_BOARD_COUNT, MAX_BOARD_ROWS } from '../../model/types'
import type { BoardSizeId, CircuitLayout, SimIssue } from '../../model/types'
import {
  FULL_CAPS,
  RENDER_MODES,
  RENDER_MODE_IDS,
  defaultMode,
  type RenderModeId,
} from '../../three/render-modes/capability'
import {
  ActionSheet,
  CheckIcon,
  ChevronLeftIcon,
  ExportIcon,
  ImportIcon,
  ListGroup,
  ListRow,
  PressableButton,
  ResetIcon,
  Segmented,
  Sheet,
  Stepper,
  TrashIcon,
  showToast,
  tick,
  useCoarsePointer,
  type SegmentedOption,
} from '../kit'
import { ApiKeyRow } from './ApiKeyRow'
// Static imports: fetch('/examples/…') would 404 in dev (repo-root files are
// not served), so the curated layouts are bundled (resolveJsonModule).
import blinky555 from '../../../examples/blinky-555.json'
import dateDisplay from '../../../examples/date-display.json'
import counter from '../../../examples/counter.json'
import nightLight from '../../../examples/night-light.json'
import pkg from '../../../package.json'
import './asm-sheets.css'

const SNAP_POINTS = [0.55, 0.92] as const

const SPEED_OPTIONS: readonly SegmentedOption<string>[] = [
  { value: '0.1', label: '0.1×' },
  { value: '0.5', label: '0.5×' },
  { value: '1', label: '1×' },
  { value: '5', label: '5×' },
  { value: '10', label: '10×' },
]

const BOARD_OPTIONS: readonly SegmentedOption<BoardSizeId>[] = [
  { value: 'half', label: BOARD_SIZES.half.label },
  { value: 'standard', label: BOARD_SIZES.standard.label },
  { value: 'labxl', label: BOARD_SIZES.labxl.label },
]

const GRAPHICS_OPTIONS: readonly SegmentedOption<RenderModeId>[] = RENDER_MODE_IDS.map((id) => ({
  value: id,
  label: RENDER_MODES[id].label,
}))

/** Tiny blue "device default" chip inside the graphics caption (module-level
 *  const — no per-render object; asm-sheets.css stays untouched). */
const DEFAULT_BADGE_STYLE: CSSProperties = {
  display: 'inline-block',
  margin: '0 7px 0 0',
  padding: '1px 7px 2px',
  borderRadius: 999,
  background: 'rgba(10, 132, 255, 0.16)',
  border: '0.5px solid rgba(10, 132, 255, 0.35)',
  color: 'var(--ios-blue)',
  font: '600 11px/14px var(--lg-font)',
  whiteSpace: 'nowrap',
  verticalAlign: '1px',
}

/** Side-by-side wide/deep steppers inside the Boards row. */
const BOARDS_LINE_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
}

/**
 * Contract bridge — fields the concurrent store work is landing on the
 * AppState contract (src/state/types.ts): `renderMode`/`setRenderMode`
 * (render-mode picker) and `setBoardRows` (2-D rigs). Read structurally and
 * guarded so this sheet compiles today and binds to the real store slice
 * the moment the contract lands.
 */
interface PendingStorePowers {
  renderMode?: RenderModeId
  setRenderMode?: (mode: RenderModeId) => void
  setBoardRows?: (n: number) => { ok: boolean; error?: string }
}
const powersOf = (s: unknown): PendingStorePowers => s as PendingStorePowers

interface ExampleEntry {
  title: string
  layout: CircuitLayout
}

const EXAMPLES: readonly ExampleEntry[] = [
  { title: '555 LED blinker', layout: blinky555 as unknown as CircuitLayout },
  { title: 'Date display', layout: dateDisplay as unknown as CircuitLayout },
  { title: '0–9 counter', layout: counter as unknown as CircuitLayout },
  { title: 'Night light', layout: nightLight as unknown as CircuitLayout },
]

const EMPTY_ISSUES: SimIssue[] = []

export interface MoreSheetProps {
  open: boolean
  onDismiss: () => void
  desktop?: boolean
}

export function MoreSheet({ open, onDismiss, desktop = false }: MoreSheetProps) {
  const simSpeed = useStore((s) => s.simSpeed)
  const setSimSpeed = useStore((s) => s.setSimSpeed)
  const resetSim = useStore((s) => s.resetSim)
  const clearBoard = useStore((s) => s.clearBoard)
  const loadLayout = useStore((s) => s.loadLayout)
  const exportJson = useStore((s) => s.exportJson)
  const select = useStore((s) => s.select)
  const layoutName = useStore((s) => s.layout.name)
  const board = useStore((s) => boardOf(s.layout))
  const setBoardSize = useStore((s) => s.setBoardSize)
  // primitive selector (not boardConfigOf — a fresh object per call would
  // re-render this sheet on every store update)
  const boardCount = useStore((s) => s.layout.boardCount ?? 1)
  const setBoardCount = useStore((s) => s.setBoardCount)
  // hardened primitive selector, same reasoning as boardCount above
  const boardRows = useStore((s) => (isBoardRows(s.layout.boardRows) ? s.layout.boardRows : 1))
  const setBoardRows = useStore((s) => powersOf(s).setBoardRows)
  // graphics: persisted store mode; until the contract lands, mirror the
  // device default the RenderModeManager would pick (phone → performance)
  const coarse = useCoarsePointer()
  const deviceDefault = defaultMode(coarse ? { ...FULL_CAPS, coarsePointer: true } : FULL_CAPS)
  const storedRenderMode = useStore((s) => powersOf(s).renderMode)
  const setRenderMode = useStore((s) => powersOf(s).setRenderMode)
  const renderMode = storedRenderMode ?? deviceDefault
  // only track live issues while the sheet is open (skip 10Hz re-renders when closed)
  const issues = useStore((s) => (open ? s.issues : EMPTY_ISSUES))

  const [view, setView] = useState<'root' | 'import'>('root')
  const [confirmClear, setConfirmClear] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [snap, setSnap] = useState(0)

  // every presentation starts back at the root list, at the half detent
  useEffect(() => {
    if (open) {
      setView('root')
      setConfirmClear(false)
      setSnap(0)
    }
  }, [open])

  const onExport = () => {
    const json = exportJson()
    const slug =
      (layoutName ?? 'circuit')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'circuit'
    try {
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${slug}.json`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } catch {
      /* download blocked — the clipboard copy below still works */
    }
    const copied = navigator.clipboard?.writeText(json)
    if (copied) {
      copied.then(
        () => showToast(`Exported ${slug}.json — copied to clipboard`),
        () => showToast(`Exported ${slug}.json`),
      )
    } else {
      showToast(`Exported ${slug}.json`)
    }
  }

  const onLoadExample = (ex: ExampleEntry) => {
    const res = loadLayout(ex.layout)
    if (res.ok) {
      tick()
      showToast(`Loaded “${ex.title}”`)
      onDismiss()
    } else {
      showToast(`Couldn’t load example: ${res.errors[0] ?? 'unknown error'}`)
    }
  }

  return (
    <>
      <Sheet
        open={open}
        onDismiss={onDismiss}
        snapPoints={SNAP_POINTS}
        activeSnap={snap}
        onSnapChange={setSnap}
        desktop={desktop}
        anchor="right"
        ariaLabel="More"
        className="asm-sheet"
      >
        {view === 'import' ? (
          <ImportView onBack={() => setView('root')} onDone={onDismiss} />
        ) : (
          <div className="asm-content asm-view">
            <div className="asm-sheet-head">
              <span className="lg-title">More</span>
            </div>

            <ListGroup header="Simulation">
              <div className="lg-row asm-row-stack" role="listitem">
                <span className="asm-row-stack-label">Speed</span>
                <Segmented
                  value={String(simSpeed)}
                  onChange={(v) => setSimSpeed(Number(v))}
                  options={SPEED_OPTIONS}
                  aria-label="Simulation speed"
                />
              </div>
              <ListRow
                leading={<ResetIcon size={20} />}
                title="Reset simulation"
                haptic
                onPress={() => {
                  resetSim()
                  showToast('Simulation reset')
                }}
              />
            </ListGroup>

            <ListGroup header="Board">
              <div className="lg-row asm-row-stack" role="listitem">
                <span className="asm-row-stack-label">Size</span>
                <Segmented<BoardSizeId>
                  value={board}
                  onChange={(v) => {
                    const res = setBoardSize(v)
                    if (!res.ok) showToast(res.error ?? 'Board size unchanged')
                  }}
                  options={BOARD_OPTIONS}
                  aria-label="Board size"
                />
              </div>
              <div className="lg-row asm-row-stack" role="listitem">
                <span className="asm-row-stack-label">Boards</span>
                <div style={BOARDS_LINE_STYLE}>
                  <Stepper
                    value={boardCount}
                    min={1}
                    max={MAX_BOARD_COUNT}
                    showValue
                    formatValue={(n) => `${n} wide`}
                    onChange={(n) => {
                      const res = setBoardCount(n)
                      if (!res.ok) showToast(res.error ?? 'Board count unchanged')
                    }}
                    aria-label="Number of boards"
                  />
                  <Stepper
                    value={boardRows}
                    min={1}
                    max={MAX_BOARD_ROWS}
                    showValue
                    formatValue={(n) => `${n} deep`}
                    onChange={(n) => {
                      const res = setBoardRows?.(n)
                      if (res && !res.ok) showToast(res.error ?? 'Board rows unchanged')
                    }}
                    aria-label="Board rows deep"
                  />
                </div>
              </div>
              <div className="lg-row" role="listitem">
                <span className="lg-caption">
                  {boardCount > 1 || boardRows > 1
                    ? `${BOARD_SIZES[board].label} ×${boardCount}${
                        boardRows > 1 ? ` · ${boardRows} deep` : ''
                      } — `
                    : ''}
                  {(BOARD_SIZES[board].points * boardCount * boardRows).toLocaleString('en-US')}{' '}
                  tie points · {BOARD_SIZES[board].cols * boardCount} columns
                </span>
              </div>
            </ListGroup>

            <ListGroup header="Graphics">
              <div className="lg-row asm-row-stack" role="listitem">
                <span className="asm-row-stack-label">Render mode</span>
                <Segmented<RenderModeId>
                  value={renderMode}
                  onChange={(v) => setRenderMode?.(v)}
                  options={GRAPHICS_OPTIONS}
                  aria-label="Render mode"
                />
              </div>
              <div className="lg-row" role="listitem">
                <span className="lg-caption">
                  {renderMode === deviceDefault && (
                    <span style={DEFAULT_BADGE_STYLE}>device default</span>
                  )}
                  {RENDER_MODES[renderMode].description}
                </span>
              </div>
            </ListGroup>

            <ListGroup header="Circuit">
              <ListRow
                leading={<ImportIcon size={20} />}
                title="Import"
                subtitle="From a .json file or pasted JSON"
                chevron
                onPress={() => {
                  setView('import')
                  setSnap(1) // full height: keeps the paste area above the keyboard
                }}
              />
              <ListRow
                leading={<ExportIcon size={20} />}
                title="Export"
                subtitle="Download + copy JSON"
                onPress={onExport}
              />
              <ListRow
                leading={<TrashIcon size={20} />}
                title="Clear board"
                destructive
                onPress={() => setConfirmClear(true)}
              />
            </ListGroup>

            <ListGroup header="Examples" footer="Loading an example replaces the current circuit.">
              {EXAMPLES.map((ex) => (
                <ListRow
                  key={ex.title}
                  title={ex.title}
                  subtitle={`${ex.layout.components.length} parts · ${ex.layout.wires.length} wires`}
                  chevron
                  onPress={() => onLoadExample(ex)}
                />
              ))}
            </ListGroup>

            <ListGroup header="Issues">
              {issues.length === 0 ? (
                <ListRow
                  leading={
                    <span style={{ color: 'var(--ios-green)', display: 'flex' }}>
                      <CheckIcon size={18} />
                    </span>
                  }
                  title="No issues"
                  subtitle="The simulator is happy"
                />
              ) : (
                issues.map((iss, i) => (
                  <ListRow
                    key={`${i}:${iss.message}`}
                    className="asm-issue-row"
                    leading={
                      <span
                        className="asm-dot"
                        style={{
                          background: iss.level === 'error' ? 'var(--ios-red)' : 'var(--ios-orange)',
                        }}
                      />
                    }
                    title={iss.message}
                    chevron={!!iss.componentId}
                    onPress={
                      iss.componentId
                        ? () => {
                            select(iss.componentId!)
                            onDismiss()
                          }
                        : undefined
                    }
                  />
                ))
              )}
            </ListGroup>

            <ListGroup header="Settings">
              <ApiKeyRow />
              <ListRow
                title="About Breadboard Studio"
                trailing={`v${pkg.version}`}
                chevron
                onPress={() => setAboutOpen((o) => !o)}
              />
              {aboutOpen && (
                <div className="asm-about" role="listitem">
                  <p>
                    A 3D breadboard playground: place real parts on an 830-point board, wire them
                    up, and watch them run on a live analog + digital simulator (custom MNA solver
                    with behavioral ICs — 555s, counters, decoders, op-amps and friends). No
                    microcontrollers, just honest electrons.
                  </p>
                  <p>
                    Layouts import and export as plain JSON, and the AI Circuit Builder drafts a
                    whole circuit from a one-line description.
                  </p>
                  <p>Designed and built with Claude.</p>
                </div>
              )}
            </ListGroup>
          </div>
        )}
      </Sheet>

      <ActionSheet
        open={confirmClear}
        onDismiss={() => setConfirmClear(false)}
        title="Clear the board?"
        message="Removes every component and wire. This cannot be undone."
        desktop={desktop}
        anchor="right"
        actions={[
          {
            label: 'Clear board',
            destructive: true,
            onSelect: () => {
              clearBoard()
              showToast('Board cleared')
            },
          },
        ]}
      />
    </>
  )
}

/**
 * Import sub-view — file picker + paste-JSON with the old ImportDialog's
 * validation flow: parse → shape check → store.loadLayout, surfacing the
 * returned errors as an inline list.
 */
function ImportView({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const loadLayout = useStore((s) => s.loadLayout)
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  const onFile = (file: File | undefined) => {
    if (!file) return
    setFileName(file.name)
    setErrors([])
    file
      .text()
      .then((t) => setText(t))
      .catch((err: unknown) => setErrors([`Could not read file: ${String(err)}`]))
  }

  const onImport = () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      setErrors([`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`])
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setErrors(['Invalid layout: expected a JSON object with "components" and "wires".'])
      return
    }
    const res = loadLayout(parsed as CircuitLayout)
    if (res.ok) {
      tick()
      showToast('Circuit imported')
      onDone()
    } else {
      setErrors(res.errors.length > 0 ? res.errors : ['Import failed (no details returned).'])
    }
  }

  return (
    <div className="asm-content asm-view">
      <div className="asm-back-row">
        <PressableButton size="sm" variant="plain" icon={<ChevronLeftIcon size={18} />} onClick={onBack}>
          More
        </PressableButton>
      </div>

      <div className="asm-sheet-head">
        <span className="lg-title">Import circuit</span>
      </div>

      <div className="asm-import-filerow">
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        <PressableButton icon={<ImportIcon size={18} />} onClick={() => fileRef.current?.click()}>
          Choose .json file…
        </PressableButton>
        {fileName && <span className="asm-import-filename asm-mono">{fileName}</span>}
      </div>

      <div className="asm-import-or lg-caption">or paste layout JSON</div>

      <textarea
        className="asm-import-text"
        rows={8}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        placeholder='{ "version": 1, "components": [ … ], "wires": [ … ] }'
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          if (errors.length > 0) setErrors([])
        }}
      />

      {errors.length > 0 && (
        <div className="asm-error" role="alert">
          <div className="asm-error-title">
            Import failed — {errors.length} {errors.length === 1 ? 'problem' : 'problems'}
          </div>
          <ul className="asm-error-msg">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <PressableButton
        variant="filled"
        size="lg"
        className="asm-block"
        disabled={text.trim().length === 0}
        onClick={onImport}
      >
        Import
      </PressableButton>
    </div>
  )
}
