/**
 * src/ui/kit — the Liquid Glass design-system kit (DESIGN.md is the spec).
 *
 * Import everything from here; importing this barrel also loads kit.css
 * (the material recipe, iOS dark palette, type scale, spring tokens, press
 * states, safe-area + reduced-motion handling).
 *
 *   import { Sheet, Dock, PressableButton, showToast, SPRING } from '../ui/kit'
 */
import './kit.css'
import { ensureGlassDefs } from './glass'

// Liquid Glass material (DESIGN.md §1): inject the SVG lens filter defs once
// (no-op outside Chromium / outside the browser) — no App.tsx hook needed.
ensureGlassDefs()

// material system
export {
  GlassDefs,
  ensureGlassDefs,
  buildDisplacementMap,
  GLASS_TIERS,
  LENS_READY_CLASS,
  type GlassTier,
  useSpecular,
  attachSpecular,
  attachToneAdapt,
  bloomAt,
  gelRelease,
  captureRect,
  morphFromRect,
  morphFromElement,
  morphToRect,
  setMorphOrigin,
  takeMorphOrigin,
  type MorphRect,
  type MorphOptions,
} from './glass'

// motion + haptics + environment
export { SPRING, DURATION, runSpring, prefersReducedMotion } from './springs'
export { tick } from './haptics'
export {
  useMediaQuery,
  useIsDesktop,
  useCoarsePointer,
  useSafeAreaInsets,
  readSafeAreaInsets,
  type SafeAreaInsets,
} from './hooks'

// controls
export { PressableButton, pressProps, type PressableButtonProps } from './PressableButton'
export { Switch, type SwitchProps } from './Switch'
export { Segmented, type SegmentedProps, type SegmentedOption } from './Segmented'
export { SliderIOS, type SliderIOSProps } from './SliderIOS'
export { Stepper, type StepperProps } from './Stepper'
export { ListGroup, type ListGroupProps } from './ListGroup'
export { ListRow, type ListRowProps } from './ListRow'

// containers + chrome
export { Sheet, DEFAULT_SNAP_POINTS, type SheetProps } from './Sheet'
export { ActionSheet, type ActionSheetProps, type ActionSheetAction } from './ActionSheet'
export { Dock, type DockProps, type DockItem } from './Dock'
export { StatusCapsule, type StatusCapsuleProps } from './StatusCapsule'
export { ToastHost } from './Toast'
export {
  showToast,
  dismissToast,
  getToasts,
  subscribeToasts,
  type ToastItem,
  type ToastOptions,
} from './toasts'

// icons
export * from './icons'
