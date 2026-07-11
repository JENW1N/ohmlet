/**
 * Sheet — the universal liquid-glass container (DESIGN.md §2).
 *
 * Material (DESIGN.md §1): the sheet is a two-layer Liquid Glass slab — the
 * 44px grabber BAND is the lens tier (`lg-lens-band`: the scene refracts
 * through the top corners/flanks; flat-bottomed map so the seam stays
 * neutral) over a regular-material body (blur 22, rim, no displacement).
 * Presentation MORPHS: when a dock tab summoned the sheet (setMorphOrigin),
 * it condenses out of the tab's rect (FLIP, composite-add over the snap
 * translate); otherwise (and for Properties auto-present) it slides. Under
 * reduced motion both paths collapse to the 160ms crossfade.
 *
 * Mobile (default): a bottom sheet over the live 3D scene with a grabber,
 * snap points (fractions of the viewport height), pointer-event dragging
 * with iOS rubber-banding past the top, velocity-based snap selection on
 * release (WAAPI spring on transform — zero React state during the drag,
 * all writes go straight to style), swipe-down-past-the-lowest-snap or
 * scrim-tap to dismiss, and a 0→0.25 black scrim (no blur). Content scrolls
 * only at the highest snap; when its scrollTop is 0 and the drag points
 * down, the sheet takes the gesture over from the scroller.
 *
 * Keyboard avoidance (mobile): while an editable inside the sheet has focus
 * and the on-screen keyboard shrinks the visual viewport, the sheet lifts by
 * the keyboard inset (transform-only, clamped at the safe-area top), the
 * content becomes scrollable at any snap with the covered region padded, the
 * focused field is scrolled above the keyboard, and the page scroll is pinned
 * to 0 so iOS can't leave the fixed shell panned after blur.
 *
 * Desktop (`desktop` prop): the same children render in a 360px floating
 * glass panel anchored left or right, sliding in with the same spring.
 *
 * Chrome interplay: while a sheet rests at ≥ ~half (or is `modal`) it adds
 * `lg-dock-covered` to <body> so the dock hides instead of sitting dead
 * under the glass; at lower snaps the dock z-stacks above the sheet and
 * stays tappable. `modal` sheets (ActionSheet) get an always-intercepting
 * scrim — tapping anywhere outside dismisses, nothing reaches the canvas.
 *
 * Accessible: role="dialog", focused on present, Escape dismisses the
 * topmost mounted sheet only (stacked dialogs close one per keypress).
 * Reduced motion: crossfades instead of slides; snaps land instantly.
 *
 * Usage:
 *   <Sheet open={open} onDismiss={() => setOpen(false)}
 *     snapPoints={[0.28, 0.55, 0.92]} activeSnap={snap} onSnapChange={setSnap}
 *     desktop={isDesktop} anchor="right" ariaLabel="Properties">
 *     …content…
 *   </Sheet>
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { DURATION, SPRING, prefersReducedMotion } from './springs'
import { tick } from './haptics'
import { readSafeAreaInsets } from './hooks'
import { attachSpecular, morphFromRect, takeMorphOrigin, type MorphRect } from './glass'

export const DEFAULT_SNAP_POINTS: readonly number[] = [0.28, 0.55, 0.92]

/* Sheets resting at ≥ ~half height (or modal ones) cover the dock; while
 * covered the dock hides via a body class (visible-but-dead glass under the
 * sheet is worse than the iOS "sheet covers the tab bar" behavior). A counter
 * supports stacked sheets (Properties + its confirm ActionSheet). */
let dockCoverCount = 0
function applyDockCover(on: boolean) {
  dockCoverCount = Math.max(0, dockCoverCount + (on ? 1 : -1))
  if (typeof document !== 'undefined') {
    document.body.classList.toggle('lg-dock-covered', dockCoverCount > 0)
  }
}

/* Mounted sheets in presentation order — Escape dismisses only the topmost.
 * (stopPropagation() does NOT stop other listeners on the same EventTarget,
 * so each sheet's document-level keydown checks this stack instead.) */
interface SheetStackEntry {
  token: object
  /** Live root element (sheet or panel). */
  el: () => HTMLElement | null
  /** Carries the regular glass chrome (not `bare`) — participates in the
   *  single-lensed-surface budget below. */
  glass: boolean
}
const sheetStack: SheetStackEntry[] = []

/* Filter/lens budget across STACKED regular sheets (DESIGN.md §1: ≤4
 * concurrent backdrop-filters, ≤3 lenses, ≤1 band/sheet lens). Two regular
 * surfaces can be mounted at once — Parts open while a selection
 * auto-presents Properties — and without intervention that stack paints two
 * band lenses + four sheet filters (5 filters total with the capsule; on
 * desktop, 4 concurrent lenses). So only the TOPMOST regular sheet/panel
 * keeps its filters: every one below is RECESSED via this class —
 * mobile sheets drop band+body backdrop-filters for near-opaque paint (they
 * sit fully behind the topmost bottom sheet anyway); desktop panels keep
 * the rich 22px blur but shed the url() displacement (kit.css). Applied on
 * mount/unmount only — never mid-exit, so a closing sheet's filters are
 * gone before the one below is promoted back to the lens tier. */
const RECESSED_CLASS = 'lg-glass-recessed'
function applyStackTiers() {
  let topmost = true
  for (let i = sheetStack.length - 1; i >= 0; i--) {
    const entry = sheetStack[i]
    if (!entry.glass) continue
    entry.el()?.classList.toggle(RECESSED_CLASS, !topmost)
    topmost = false
  }
}

const SCRIM_MAX = 0.25
/* Modal (ActionSheet) scrims dim harder: their cards are the CLEAR glass
 * variant, and the HIG's "clear requires a dimming layer" is carried by
 * scrim + baked card dim together (kit.css .lg-sheet .lg-asheet-group). */
const SCRIM_MAX_MODAL = 0.45
const DECIDE_SLOP = 6 // px of movement before we classify drag vs scroll
const VELOCITY_LOOKAHEAD = 180 // ms of projection for snap selection
const DISMISS_VELOCITY = 1.1 // px/ms downward fling at the lowest snap
const KEYBOARD_MARGIN = 12 // px gap kept between a focused field and the keyboard

/* Liquid Glass morph-present (DESIGN.md §1 behavior 5): when a dock tab
 * summoned this sheet (Dock.tsx left its rect via setMorphOrigin), the sheet
 * CONDENSES out of the tab instead of sliding. Subtle: the FLIP starts this
 * fraction of the way from the tab's rect toward the sheet's own — far
 * enough to read "grew out of the tab", never a cartoonish 0.1× pop. */
const MORPH_CONDENSE = 0.45
const MORPH_PRESENT_MS = 360 // "fast": quicker than the 420ms slide

const lerpRect = (a: MorphRect, b: MorphRect, t: number): MorphRect => ({
  left: a.left + (b.left - a.left) * t,
  top: a.top + (b.top - a.top) * t,
  width: a.width + (b.width - a.width) * t,
  height: a.height + (b.height - a.height) * t,
})

/** Focus on one of these (with the keyboard inset > 0) triggers avoidance. */
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable]'

interface KeyboardState {
  /** px of layout viewport covered by the on-screen keyboard */
  inset: number
  /** px the sheet is lifted above its logical snap position */
  lift: number
  /** keyboard up AND an editable inside the sheet has focus */
  active: boolean
}

export interface SheetProps {
  open: boolean
  /** Called after a user-initiated dismissal (swipe past bottom, scrim tap,
   *  Escape). The parent must respond by setting `open` to false. */
  onDismiss: () => void
  children?: ReactNode
  /** Ascending fractions of viewport height, e.g. [0.28, 0.55, 0.92]. */
  snapPoints?: readonly number[]
  /** Controlled snap index into snapPoints. */
  activeSnap?: number
  onSnapChange?: (index: number) => void
  /** Black dim behind the sheet (mobile only). Default true. */
  scrim?: boolean
  /** Floating 360px glass panel instead of a bottom sheet. */
  desktop?: boolean
  /** Which edge the desktop panel hugs. Default 'right'. */
  anchor?: 'left' | 'right'
  /** Drop the glass chrome + grabber (ActionSheet supplies its own cards). */
  bare?: boolean
  /** iOS-modal: the scrim intercepts (and dismisses on tap) at EVERY snap,
   *  and the sheet+scrim stack above non-modal sheets. Used by ActionSheet,
   *  whose content-sized snap sits below the regular ~half threshold. */
  modal?: boolean
  ariaLabel?: string
  className?: string
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

/** Read the live translateY out of a computed transform matrix. */
function currentTranslateY(el: HTMLElement): number {
  const t = getComputedStyle(el).transform
  if (!t || t === 'none') return 0
  const m3 = t.match(/matrix3d\(([^)]+)\)/)
  if (m3) return parseFloat(m3[1].split(',')[13]) || 0
  const m = t.match(/matrix\(([^)]+)\)/)
  if (m) return parseFloat(m[1].split(',')[5]) || 0
  return 0
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  startPos: number
  mode: 'undecided' | 'drag' | 'scroll'
  samples: { t: number; y: number }[]
}

export function Sheet({
  open,
  onDismiss,
  children,
  snapPoints = DEFAULT_SNAP_POINTS,
  activeSnap,
  onSnapChange,
  scrim = true,
  desktop = false,
  anchor = 'right',
  bare = false,
  modal = false,
  ariaLabel,
  className,
}: SheetProps) {
  const [mounted, setMounted] = useState(open)
  const mountedRef = useRef(mounted)
  mountedRef.current = mounted

  const sheetRef = useRef<HTMLDivElement | null>(null)
  const scrimRef = useRef<HTMLDivElement | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const animRef = useRef<Animation | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const posRef = useRef(0) // current logical translateY in px (mobile, lift excluded)
  const kbRef = useRef<KeyboardState>({ inset: 0, lift: 0, active: false })
  const sheetHRef = useRef(1)
  const snapIndexRef = useRef(0)
  const closingRef = useRef(false)
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  const onSnapChangeRef = useRef(onSnapChange)
  onSnapChangeRef.current = onSnapChange
  const activeSnapRef = useRef(activeSnap)
  activeSnapRef.current = activeSnap
  const stackToken = useRef<object>({}).current
  const coversDockRef = useRef(false)
  const setDockCovered = (on: boolean) => {
    if (on === coversDockRef.current) return
    coversDockRef.current = on
    applyDockCover(on)
  }

  const fracs = useMemo(() => {
    const f = snapPoints
      .map((v) => clamp(v, 0.05, 1))
      .slice()
      .sort((a, b) => a - b)
    return f.length > 0 ? f : DEFAULT_SNAP_POINTS.slice()
    // join() gives value identity so callers can pass fresh arrays
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapPoints.join(',')])
  const maxFrac = fracs[fracs.length - 1]

  const clampIndex = (i: number) => clamp(Math.round(i), 0, fracs.length - 1)
  const translateFor = (i: number) => sheetHRef.current * (1 - fracs[i] / maxFrac)
  const scrimMax = modal ? SCRIM_MAX_MODAL : SCRIM_MAX
  const scrimOpacityFor = (y: number) =>
    clamp(scrimMax * (1 - y / Math.max(sheetHRef.current, 1)), 0, scrimMax)

  /** Rendered translateY for a logical position (keyboard lift applied).
   *  While lifted, clamp so the sheet top never crosses the safe-area top —
   *  the lift is sized for the snap it was computed at, but drags/snap
   *  changes can move the logical position out from under it. */
  const renderY = (y: number) => {
    const lift = kbRef.current.lift
    if (lift <= 0) return y
    const minRendered =
      readSafeAreaInsets().top + 8 - (window.innerHeight - sheetHRef.current)
    return Math.max(y - lift, Math.min(minRendered, y))
  }

  /** Direct visual write — used per pointermove, never touches React state. */
  const setVisual = (y: number) => {
    posRef.current = y
    const el = sheetRef.current
    if (el) el.style.transform = `translate3d(0, ${renderY(y)}px, 0)`
    const s = scrimRef.current
    if (s) s.style.opacity = String(scrimOpacityFor(y))
  }

  /** iOS rubber band above the top snap (drags below track 1:1 → dismiss). */
  const rubberBand = (y: number) => {
    if (y >= 0) return y
    const dim = sheetHRef.current
    const d = -y
    return -(dim * (1 - 1 / (1 + (d * 0.55) / dim)))
  }

  /** Spring the sheet (and scrim) to a translateY via WAAPI. */
  const animateSheet = (toY: number, ms: number, onDone?: () => void) => {
    const el = sheetRef.current
    if (!el) {
      onDone?.()
      return
    }
    const fromY = posRef.current
    const s = scrimRef.current
    const fromOpacity = s ? parseFloat(s.style.opacity || '0') || 0 : 0
    setVisual(toY)
    if (prefersReducedMotion() || typeof el.animate !== 'function') {
      onDone?.()
      return
    }
    animRef.current?.cancel()
    const a = el.animate(
      [
        { transform: `translate3d(0, ${renderY(fromY)}px, 0)` },
        { transform: `translate3d(0, ${renderY(toY)}px, 0)` },
      ],
      { duration: ms, easing: SPRING },
    )
    animRef.current = a
    a.onfinish = () => {
      if (animRef.current === a) animRef.current = null
      onDone?.()
    }
    a.oncancel = () => {
      if (animRef.current === a) animRef.current = null
    }
    if (s && typeof s.animate === 'function') {
      s.animate([{ opacity: fromOpacity }, { opacity: scrimOpacityFor(toY) }], {
        duration: ms,
        easing: SPRING,
      })
    }
  }

  /** Scroll/scrim affordances that depend on the resting snap (and keyboard). */
  const applySnapState = (i: number) => {
    const sc = scrollerRef.current
    const kb = kbRef.current
    // while the keyboard covers the sheet, content must scroll at ANY snap so
    // iOS (and the user) can bring the focused field / actions above it
    const scrollable = i === fracs.length - 1 || kb.active
    if (sc) {
      sc.style.overflowY = scrollable ? 'auto' : 'hidden'
      sc.style.touchAction = scrollable ? 'pan-y' : 'none'
      // pad the content tail by the region the keyboard (minus the lift) hides
      const covered = kb.active ? Math.max(0, translateFor(i) + kb.inset - kb.lift) : 0
      sc.style.paddingBottom =
        covered > 0 ? `calc(var(--lg-safe-bottom) + 16px + ${Math.round(covered)}px)` : ''
    }
    const covers = modal || fracs[i] >= 0.45
    const s = scrimRef.current
    // modal sheets (action sheets) intercept at every snap so outside taps
    // dismiss instead of reaching the canvas; regular sheets free the canvas
    // until they cover ~half
    if (s) s.style.pointerEvents = covers ? 'auto' : 'none'
    // hide the dock while covered; at low snaps it stays visible AND tappable
    // (it z-stacks above the sheet) so tabs remain reachable during peek
    setDockCovered(covers)
  }

  const settle = (i: number, notify: boolean) => {
    snapIndexRef.current = i
    const toY = translateFor(i)
    const dist = Math.abs(toY - posRef.current)
    const ms = clamp(180 + (dist / Math.max(sheetHRef.current, 1)) * 340, 200, DURATION.sheet)
    animateSheet(toY, ms)
    applySnapState(i)
    if (notify) {
      tick()
      onSnapChangeRef.current?.(i)
    }
  }
  const settleRef = useRef(settle)
  settleRef.current = settle

  /** Animate out, then unmount; optionally report the dismissal upward. */
  const closeSheet = (notify: boolean) => {
    if (closingRef.current || !mountedRef.current) return
    closingRef.current = true
    dragRef.current = null
    // drop any keyboard lift so the exit animation ends fully off-screen
    kbRef.current = { inset: 0, lift: 0, active: false }
    // release chrome immediately: dock fades back in during the exit slide,
    // Escape targets the next sheet, the dying scrim stops eating taps
    setDockCovered(false)
    // (applyStackTiers waits for the real unmount — promoting the sheet
    // below while this one still filters would overlap budgets mid-exit)
    const si = sheetStack.findIndex((e) => e.token === stackToken)
    if (si >= 0) sheetStack.splice(si, 1)
    if (scrimRef.current) scrimRef.current.style.pointerEvents = 'none'
    if (notify) tick()
    const finish = () => {
      setMounted(false)
      if (notify) onDismissRef.current()
    }
    const el = sheetRef.current
    if (!el) {
      finish()
      return
    }
    const canAnimate = typeof el.animate === 'function'
    if (prefersReducedMotion() && canAnimate) {
      // reduced motion: crossfade out instead of sliding
      const s = scrimRef.current
      if (s) s.style.opacity = '0'
      const a = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'linear' })
      a.onfinish = finish
    } else if (!desktop && canAnimate) {
      animateSheet(sheetHRef.current, 320, finish)
    } else if (desktop && canAnimate) {
      const dx = anchor === 'left' ? -420 : 420
      el.style.transform = `translate3d(${dx}px, 0, 0)`
      const a = el.animate(
        [{ transform: 'translate3d(0, 0, 0)' }, { transform: `translate3d(${dx}px, 0, 0)` }],
        { duration: 300, easing: SPRING },
      )
      a.onfinish = finish
    } else {
      finish()
    }
  }
  const closeRef = useRef(closeSheet)
  closeRef.current = closeSheet

  /* ----- mount/unmount on `open` ----- */
  useEffect(() => {
    if (open) {
      closingRef.current = false
      setMounted(true)
    } else if (mountedRef.current && !closingRef.current) {
      // parent closed it directly — animate out without re-reporting
      closeRef.current(false)
    }
  }, [open])

  /* ----- presentation (runs whenever the dialog (re)mounts) ----- */
  useLayoutEffect(() => {
    if (!mounted) return
    closingRef.current = false
    const el = sheetRef.current
    if (!el) return
    if (desktop) {
      const dx = anchor === 'left' ? -420 : 420
      if (prefersReducedMotion() && typeof el.animate === 'function') {
        el.style.transform = 'translate3d(0, 0, 0)'
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'linear' })
      } else if (typeof el.animate === 'function') {
        el.style.transform = 'translate3d(0, 0, 0)'
        el.animate(
          [{ transform: `translate3d(${dx}px, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
          { duration: DURATION.dock, easing: SPRING },
        )
      } else {
        el.style.transform = 'translate3d(0, 0, 0)'
      }
      el.focus({ preventScroll: true })
      return
    }
    const h = el.getBoundingClientRect().height || 1
    sheetHRef.current = h
    const i = clampIndex(activeSnapRef.current ?? Math.min(1, fracs.length - 1))
    snapIndexRef.current = i
    posRef.current = h
    setVisual(h)
    const origin = !bare ? takeMorphOrigin() : null
    if (origin && typeof el.animate === 'function') {
      // Liquid Glass morph-present: land on the snap, then FLIP-condense out
      // of the dock tab that summoned us (composite 'add' rides on top of the
      // snap's base translate3d). Under reduced motion morphFromRect degrades
      // to the same 160ms crossfade as the regular presentation path.
      setVisual(translateFor(i))
      const from = lerpRect(origin, el.getBoundingClientRect(), MORPH_CONDENSE)
      const a = morphFromRect(el, from, {
        duration: MORPH_PRESENT_MS,
        fade: true,
        composite: 'add',
      })
      if (a) {
        animRef.current = a
        a.onfinish = () => {
          if (animRef.current === a) animRef.current = null
        }
        a.oncancel = () => {
          if (animRef.current === a) animRef.current = null
        }
      }
      const s = scrimRef.current
      if (s && typeof s.animate === 'function' && !prefersReducedMotion()) {
        s.animate([{ opacity: 0 }, { opacity: scrimOpacityFor(translateFor(i)) }], {
          duration: MORPH_PRESENT_MS,
          easing: SPRING,
        })
      }
    } else if (prefersReducedMotion()) {
      setVisual(translateFor(i))
      if (typeof el.animate === 'function') {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'linear' })
      }
    } else {
      animateSheet(translateFor(i), DURATION.sheet)
    }
    applySnapState(i)
    el.focus({ preventScroll: true })
    return () => {
      animRef.current?.cancel()
      animRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, desktop])

  /* ----- Liquid Glass: tracked specular sheen on the glass surface -----
     One registration on the root covers band + body (the ::after sheen layer
     paints above both children, and the root's overflow clip doubles as the
     band/body rim trim). Bare sheets supply their own cards and skip it. */
  useEffect(() => {
    if (!mounted || bare) return
    const el = sheetRef.current
    if (!el) return
    return attachSpecular(el)
  }, [mounted, bare, desktop])

  /* ----- presentation stack + chrome cleanup -----
     Pushing/popping also re-tiers the stacked glass (applyStackTiers): only
     the topmost regular sheet/panel keeps its backdrop-filters + lens. */
  useEffect(() => {
    if (!mounted) return
    sheetStack.push({ token: stackToken, el: () => sheetRef.current, glass: !bare })
    applyStackTiers()
    return () => {
      const i = sheetStack.findIndex((e) => e.token === stackToken)
      if (i >= 0) sheetStack.splice(i, 1)
      applyStackTiers()
      // a sheet can unmount (or flip to desktop panel mode) without
      // closeSheet running — never leak a dock-cover count
      if (coversDockRef.current) {
        coversDockRef.current = false
        applyDockCover(false)
      }
    }
  }, [mounted, desktop, bare, stackToken])

  /* ----- Escape dismisses the TOPMOST sheet only (light focus handling) ----- */
  useEffect(() => {
    if (!mounted) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (sheetStack[sheetStack.length - 1]?.token !== stackToken) return
      e.stopPropagation()
      closeRef.current(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [mounted, stackToken])

  /* ----- controlled activeSnap ----- */
  useEffect(() => {
    if (!mounted || desktop || activeSnap == null) return
    const i = clampIndex(activeSnap)
    if (i !== snapIndexRef.current) settleRef.current(i, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSnap, mounted, desktop])

  /* ----- keep geometry honest across rotation/resize ----- */
  useEffect(() => {
    if (!mounted || desktop) return
    const onResize = () => {
      const el = sheetRef.current
      if (!el || dragRef.current) return
      sheetHRef.current = el.getBoundingClientRect().height || 1
      setVisual(translateFor(snapIndexRef.current))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, desktop, fracs])

  /* ----- keyboard avoidance (mobile) -----
     The iOS keyboard shrinks the visual viewport without resizing the layout
     viewport, so a field focused at the 0.55 detent sits behind it and Safari
     pans the position:fixed shell unpredictably instead. While an editable
     inside the sheet has focus: lift the sheet by the keyboard inset (clamped
     at the safe-area top, house spring, transform only), let the content
     scroll at any snap with the covered region padded, nudge the focused
     field above the keyboard, and pin the page scroll back to 0 so the
     capsule/dock never end up stuck offset after blur. */
  useEffect(() => {
    if (!mounted || desktop || typeof window === 'undefined') return
    const el = sheetRef.current
    if (!el) return
    const vv = window.visualViewport
    let raf = 0

    const update = () => {
      raf = 0
      const sheet = sheetRef.current
      if (!sheet || closingRef.current) return
      const inset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0
      const focused = document.activeElement
      const editing =
        inset > 0 &&
        focused instanceof HTMLElement &&
        sheet.contains(focused) &&
        focused.matches(EDITABLE_SELECTOR)
      // Safari pans the fixed shell to chase the field; pin it back (this is
      // what otherwise leaves the layout stuck offset after blur).
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0)
      let lift = 0
      if (editing) {
        // lift by the keyboard inset, clamped so the sheet top clears the notch
        const headroom =
          window.innerHeight - sheetHRef.current + posRef.current - (readSafeAreaInsets().top + 8)
        lift = clamp(inset, 0, Math.max(0, headroom))
      }
      const prev = kbRef.current
      const renderedNow = currentTranslateY(sheet)
      if (inset !== prev.inset || lift !== prev.lift || editing !== prev.active) {
        kbRef.current = { inset, lift, active: editing }
        applySnapState(snapIndexRef.current)
        if (lift !== prev.lift && !dragRef.current) {
          animRef.current?.cancel()
          setVisual(posRef.current) // commit the new rendered position
          if (!prefersReducedMotion() && typeof sheet.animate === 'function') {
            const a = sheet.animate(
              [
                { transform: `translate3d(0, ${renderedNow}px, 0)` },
                { transform: `translate3d(0, ${renderY(posRef.current)}px, 0)` },
              ],
              { duration: DURATION.dock, easing: SPRING },
            )
            animRef.current = a
            a.onfinish = () => {
              if (animRef.current === a) animRef.current = null
            }
            a.oncancel = () => {
              if (animRef.current === a) animRef.current = null
            }
          }
        }
      }
      // scroll the focused field above the keyboard inside the content
      if (editing) {
        const sc = scrollerRef.current
        if (sc && typeof sc.scrollTo === 'function') {
          const rect = focused.getBoundingClientRect()
          const settleShift = renderY(posRef.current) - renderedNow // ≤ 0 while lifting
          const overshoot =
            rect.bottom + settleShift - (window.innerHeight - inset - KEYBOARD_MARGIN)
          if (overshoot > 1) {
            sc.scrollTo({
              top: sc.scrollTop + overshoot,
              behavior: prefersReducedMotion() ? 'auto' : 'smooth',
            })
          }
        }
      }
    }

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    vv?.addEventListener('resize', schedule)
    vv?.addEventListener('scroll', schedule)
    el.addEventListener('focusin', schedule)
    el.addEventListener('focusout', schedule)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      vv?.removeEventListener('resize', schedule)
      vv?.removeEventListener('scroll', schedule)
      el.removeEventListener('focusin', schedule)
      el.removeEventListener('focusout', schedule)
      kbRef.current = { inset: 0, lift: 0, active: false }
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, desktop])

  /* ----- iOS scroll→drag handoff (mobile) -----
     touch-action is evaluated at gesture START, so flipping the scroller to
     touch-action:none mid-gesture (onPointerMove) cannot stop a native scroll
     iOS has already begun — Safari rubber-bands locally and fires
     pointercancel, killing the "drag the sheet down from its scrolled-to-top
     content" collapse. A non-passive touchmove listener prevents the native
     scroll from ever starting for gestures the sheet claims (or is about to
     claim), mirroring onPointerMove's classifier. Horizontal moves are left
     alone so nested pan-x scrollers (category chips, E12 row) keep working. */
  useEffect(() => {
    if (!mounted || desktop) return
    const el = sheetRef.current
    if (!el) return
    const onTouchMove = (e: TouchEvent) => {
      const d = dragRef.current
      if (!d || d.mode === 'scroll' || !e.cancelable) return
      if (d.mode === 'drag') {
        e.preventDefault()
        return
      }
      const t = e.touches[0]
      if (!t) return
      const dx = t.clientX - d.startX
      const dy = t.clientY - d.startY
      if (Math.abs(dx) > Math.abs(dy)) return // possible nested pan-x gesture
      const sc = scrollerRef.current
      const scrollable = snapIndexRef.current === fracs.length - 1 || kbRef.current.active
      const wantsNativeScroll =
        !!sc && sc.contains(e.target as Node) && scrollable && (sc.scrollTop > 1 || dy < 0)
      if (!wantsNativeScroll) e.preventDefault()
    }
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => el.removeEventListener('touchmove', onTouchMove)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, desktop, fracs])

  /* ----- drag machinery (mobile) ----- */
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (desktop || closingRef.current) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (dragRef.current) return // ignore secondary touches
    const el = sheetRef.current
    if (!el) return
    if (animRef.current) {
      // grab a sheet mid-flight exactly where it is (logical = rendered + lift)
      const y = currentTranslateY(el) + kbRef.current.lift
      animRef.current.cancel()
      setVisual(y)
    }
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startPos: posRef.current,
      mode: 'undecided',
      samples: [{ t: e.timeStamp, y: e.clientY }],
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pointerId || closingRef.current) return
    const dy = e.clientY - d.startY
    if (d.mode === 'undecided') {
      if (Math.abs(dy) < DECIDE_SLOP) return
      const sc = scrollerRef.current
      const inScroller = !!sc && sc.contains(e.target as Node)
      const scrollable = snapIndexRef.current === fracs.length - 1 || kbRef.current.active
      if (inScroller && scrollable && (sc.scrollTop > 1 || dy < 0)) {
        d.mode = 'scroll' // hand the gesture to native scrolling
        return
      }
      // the sheet takes over: capture, freeze the scroller, re-base
      d.mode = 'drag'
      d.startY = e.clientY
      d.startPos = posRef.current
      sheetRef.current?.setPointerCapture(e.pointerId)
      if (sc) {
        sc.style.overflowY = 'hidden'
        sc.style.touchAction = 'none'
      }
      return
    }
    if (d.mode !== 'drag') return
    d.samples.push({ t: e.timeStamp, y: e.clientY })
    if (d.samples.length > 8) d.samples.shift()
    setVisual(rubberBand(d.startPos + (e.clientY - d.startY)))
  }

  const finishDrag = (velocity: number) => {
    const h = sheetHRef.current
    const projected = posRef.current + velocity * VELOCITY_LOOKAHEAD
    const lowestY = translateFor(0)
    const dismissPoint = lowestY + Math.min(140, (h - lowestY) * 0.5)
    const flungDown = velocity > DISMISS_VELOCITY && snapIndexRef.current === 0
    if (projected > dismissPoint || flungDown) {
      closeSheet(true)
      return
    }
    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < fracs.length; i++) {
      const dist = Math.abs(translateFor(i) - projected)
      if (dist < bestDist) {
        bestDist = dist
        best = i
      }
    }
    settle(best, best !== snapIndexRef.current)
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pointerId) return
    dragRef.current = null
    if (d.mode !== 'drag') return
    try {
      sheetRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* capture may already be gone */
    }
    const tNow = e.timeStamp
    const recent = d.samples.filter((p) => tNow - p.t < 110)
    const first = recent[0] ?? d.samples[0]
    const velocity = tNow > first.t ? (e.clientY - first.y) / (tNow - first.t) : 0
    finishDrag(velocity)
  }

  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pointerId) return
    dragRef.current = null
    if (d.mode === 'drag') settle(snapIndexRef.current, false)
  }

  if (!mounted || typeof document === 'undefined') return null

  if (desktop) {
    return createPortal(
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="false"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={[
          'lg-panel',
          anchor === 'left' ? 'lg-panel-left' : 'lg-panel-right',
          // panels are sheet-tier lenses (≈360px wide ≈ the nominal map)
          bare ? '' : 'lg-surface lg-lens lg-lens-sheet',
          className ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ transform: `translate3d(${anchor === 'left' ? -420 : 420}px, 0, 0)` }}
      >
        <div ref={scrollerRef} className="lg-panel-content">
          {children}
        </div>
      </div>,
      document.body,
    )
  }

  return createPortal(
    <>
      {scrim && (
        <div
          ref={scrimRef}
          className={modal ? 'lg-sheet-scrim is-modal' : 'lg-sheet-scrim'}
          aria-hidden="true"
          onPointerUp={() => closeSheet(true)}
        />
      )}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={[
          'lg-sheet',
          bare ? 'is-bare' : '',
          modal ? 'is-modal' : '',
          className ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ height: `${maxFrac * 100}dvh`, transform: 'translate3d(0, 100%, 0)' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        {bare ? (
          // modal ActionSheets supply their own clear-variant cards
          <div ref={scrollerRef} className="lg-sheet-content">
            {children}
          </div>
        ) : (
          <>
            {/* The grabber band is the sheet's LENS strip (DESIGN.md §1 tier
                L): the scene visibly refracts through the top corners and
                flanks. The body below stays the cheaper regular material —
                so only the topmost regular sheet carries a (band-sized)
                lens, never a full sheet-sized displacement. */}
            <div className="lg-sheet-band lg-surface lg-lens lg-lens-band">
              <div className="lg-sheet-grabber" />
            </div>
            <div className="lg-sheet-body lg-surface">
              <div ref={scrollerRef} className="lg-sheet-content">
                {children}
              </div>
            </div>
          </>
        )}
      </div>
    </>,
    document.body,
  )
}
