/**
 * src/ui/kit/glass — the Liquid Glass material system (DESIGN.md §1).
 *
 *  - GlassDefs / ensureGlassDefs: the SVG edge-refraction lens filters
 *  - useSpecular / attachSpecular: the shared pointer-tracked sheen
 *  - attachToneAdapt: backdrop-luminance adaptation (light/dark platter flip
 *    + continuous adaptive-shadow --lg-lum) for the floating chrome
 *  - bloomAt / gelRelease: the gel press response
 *  - captureRect / morphFromRect / morphFromElement / morphToRect: FLIP morphs
 */
export {
  GlassDefs,
  ensureGlassDefs,
  buildDisplacementMap,
  GLASS_TIERS,
  LENS_READY_CLASS,
  type GlassTier,
} from './GlassDefs'
export { useSpecular, attachSpecular } from './useSpecular'
export { attachToneAdapt } from './adapt'
export { bloomAt, gelRelease } from './gel'
export {
  captureRect,
  morphFromRect,
  morphFromElement,
  morphToRect,
  setMorphOrigin,
  takeMorphOrigin,
  type MorphRect,
  type MorphOptions,
} from './morph'
