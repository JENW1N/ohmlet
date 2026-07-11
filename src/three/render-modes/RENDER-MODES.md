# Render Modes — Performance / Enhanced / Studio

The render-mode engine lives entirely in `src/three/render-modes/`. The scene
integrator consumes ONE class — `RenderModeManager` (`manager.ts`) — whose
full wiring contract is documented in that file's header docblock. Summary:

```ts
const modes = new RenderModeManager()
modes.init(renderer, scene, camera)                  // scene.mount()
if (!modes.render(dt)) renderer.render(scene, camera) // rAF loop (replaces the plain call)
controls.addEventListener('start', () => modes.onInteractionStart())
controls.addEventListener('end',   () => modes.onInteractionEnd())
modes.invalidate()              // any scene-graph change (layout sync, wires, board rebuild)
modes.invalidate('materials')   // telemetry-only visuals (LED emissive) — no BVH rebuild
modes.setSize(w, h)             // on resize, after renderer.setSize
modes.setMode('studio')         // persists to localStorage 'bb.renderMode'
modes.on('modechange', cb); modes.on('progress', cb) // cb payloads: see types.ts
modes.dispose()                 // scene.dispose()
```

`render(dt)` returns **true iff the manager drew the frame**. Performance mode
always returns false so the scene's existing `renderer.render(scene, camera)`
line keeps running untouched (zero added cost); false is also returned for the
few frames a lazily-loaded pipeline is still arriving — the plain render is
the universal safety net.

**Overlay compositing (Studio).** After a `render()` that returns true,
`modes.pathTracedFrame` tells the integrator whether that frame was the
path-traced canvas (sampling, or a held converged still — Studio re-blits the
accumulated still through its fullscreen quad every frame precisely so the
canvas always has defined contents). When it is, scene.ts re-renders its
raster overlays (the `bbNoStudio`-excluded subtree: holograms, hover ring,
selection boxes, previews, grow paddles) on top via a camera-layer pass with
`autoClear` off and a depth clear — so placement/wiring/hover stay fully live
over a converging or held still. Enhanced(-fallback) frames already include
the overlays through the composer's RenderPass and must NOT be composited
again (double-draw would brighten the transparent FX).

UI picker data: `RENDER_MODES` metadata + `modes.supported` (capability-aware
list) from `capability.ts`. Default mode: phone (coarse pointer) →
`performance`, desktop → `enhanced`; a persisted, *supported* user override
in `localStorage['bb.renderMode']` wins over the device default.

## The three modes

| | pipeline | cost |
|---|---|---|
| **Performance** | the untouched scene.ts raster path (RoomEnvironment IBL, one 2048 shadow map) | zero added |
| **Enhanced** | HDRI IBL + EffectComposer: RenderPass → SAO → UnrealBloom (threshold 1.0 — only HDR emitters bloom: LED glows, hot speculars) → OutputPass (ACES + sRGB once) → SMAA; key shadow map 4096 on desktop (still ONE on-demand map, restored on leaving the mode). SAO runs at **½ resolution** (AO is low-frequency; pixel-unit params rescaled so the world-space footprint is identical, linear-filtered composite = free bilinear upsample) and its normal/depth pre-pass **skips a cached list** of meshes that cannot affect the AO term (transparent/non-depth-writing materials + sub-`SAO_PREPASS_MIN_RADIUS` meshes — wire caps, tip pins, band rings); the cache re-collects on `invalidate()` | ~3 fullscreen passes |
| **Studio** | three-gpu-pathtracer progressive path tracing of the SAME scene graph; converges while idle (`progress` events carry samples/pixel), drops to Enhanced raster during camera motion / BVH builds, re-converges when still; internal resolution = device base (full desktop, 0.75× phone) **clamped by `STUDIO_PIXEL_BUDGET` (~2.6 MP)** — a 5.2 MP retina canvas traces at ~0.71× instead of crashing the GPU process; tiling sized so one per-rAF tile burst fits `STUDIO_TILE_PIXEL_BUDGET`, with a finer restart ladder (`studioRestartTiles`) for the first samples after every accumulation reset; BVH rebuilds only on `invalidate()`, on a Web Worker when available | GPU-bound while converging, then holds the still |

Tone mapping stays ACES filmic in every mode: Enhanced applies it exactly once
in `OutputPass`; Studio presents through the renderer (`renderToCanvas`), which
applies the renderer's tone mapping at the final blit.

Enhanced's environment swap uses `EquirectangularReflectionMapping` on the raw
`.hdr` texture — the renderer PMREMs it internally (cached), and the path
tracer ingests the *same* equirect texture for its environment, so raster
fallback and path-traced still are lit identically. The displaced
RoomEnvironment PMREM is restored when leaving Enhanced/Studio.

## Dependency: three-gpu-pathtracer

- **Installed: `three-gpu-pathtracer@0.0.23`** + peer **`three-mesh-bvh@0.7.8`**.
- Version rationale (checked against npm peer metadata + the GitHub release
  notes on 2026-06-12): 0.0.24 raised the minimum three.js to **r180** and
  switched RGBELoader→HDRLoader, so it cannot run on this project's
  `three@0.170`; **0.0.23 is the newest release supporting `three >=0.151`**.
  Upgrading three itself was not required.
- three-mesh-bvh is pinned to the **0.7.x line** (peer range `>=0.7.4`):
  0.9.4 changed the packed BVH buffer layout (uint32 offsets → node indices)
  that the path tracer's GLSL traversal reads directly, so the era-matched
  0.7.8 is the safe pairing for pathtracer 0.0.23.
- `xatlas-web` is an npm-auto-installed peer (used only by the library's UV
  unwrapper, which we never import).
- **Lazy chunk (REQUIRED):** `studio.ts` is the only module importing
  `three-gpu-pathtracer`, and the manager reaches it only through
  `import('./studio')` — Vite emits it as a separate chunk, so Performance
  and Enhanced users never download the path tracer. `enhanced.ts` (composer
  passes + RGBELoader) is likewise dynamically imported. A vitest guard
  (`tests/render-modes.test.ts`) enforces both invariants by scanning the
  sources.
- BVH builds: `GenerateMeshBVHWorker` (deep import, typed by
  `bvh-worker.d.ts`) is probed once with a 1-triangle build; if the worker
  can't spin up (bundler/dev-server quirks, CSP), Studio permanently falls
  back to synchronous main-thread builds for the session. A failed *async*
  build can wedge the generator, so that path also rebuilds the
  `WebGLPathTracer` in sync mode. (`ParallelMeshBVHWorker` was rejected: it
  requires SharedArrayBuffer / cross-origin isolation headers.)

## HDRI asset

- `public/hdri/studio_small_03_1k.hdr` (~1.6 MB, Radiance HDR, 1k).
- Source: **Poly Haven** — https://polyhaven.com/a/studio_small_03
  (downloaded from `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/studio_small_03_1k.hdr`).
- License: **CC0 1.0 Universal** (public domain — no attribution required;
  credit: Sergej Majboroda / Poly Haven).

## Material & scene-graph caveats for asset agents (Studio mode)

Verified against the 0.0.23 sources (`src/uniforms/MaterialsTexture.js`,
`src/core/utils/StaticGeometryGenerator.js`):

- **Supported MeshPhysicalMaterial features**: metalness/roughness (+maps),
  **transmission** (+attenuation color/distance, IOR), **clearcoat**
  (+roughness/normal maps), sheen, iridescence, specular color/intensity,
  emissive (+intensity), normal/bump maps, alphaTest/opacity, side. LED
  glass/epoxy reads correctly. `matte` and per-material `castShadow`
  extensions exist if ever needed.
- **Clearcoat caveat (verified empirically, scope widened in Phase-C
  verification)**: 0.0.23's clearcoat lobe goes BLACK at grazing view
  angles. First seen on the board slab (`internal/board.ts` bodyMat), and
  originally believed limited to large flat surfaces — but converged wide
  (home-framing) stills turned the WHOLE blinky circuit into a black
  silhouette: wire PVC (clearcoat 0.15), resistor lacquer (0.55), molded
  DIP epoxy and LED glass all hit the same lobe bug at those angles.
  `studio.ts` therefore suppresses clearcoat on EVERY clearcoated material
  while Studio is active — but FOLDS the coat into the base lobe rather
  than plain-zeroing it (plain zeroing left the lacquer/PVC/epoxy parts
  reading satin in exactly the photoreal mode): base roughness is pulled
  toward the coat's own (glossier) `clearcoatRoughness` and
  `specularIntensity` gains the coat's added reflectance, so the dip-coat
  window highlights survive through the base specular lobe. Saved values
  ({clearcoat, roughness, specularIntensity}) are restored on dispose;
  raster pipelines outside Studio are untouched — though the Enhanced
  fallback shown during camera motion in Studio mode shares the folded
  coat for session consistency. The legacy `bbStudioNoClearcoat` flag is
  subsumed by the global fold. Tuning constants `COAT_FOLD_*` sit at the
  top of `studio.ts`.
- **Camera realism (Studio still only)**: the path tracer never sees the
  scene's pinhole camera — `studio.ts` renders through a `PhysicalCamera`
  MIRROR (matrices copied from the live camera whenever it settles). Focus
  is placed where the view ray meets the component-height plane (orbit
  framings aim at the board; `DOF_FOCUS_PLANE_Y`), and the aperture
  diameter scales with the focus distance (`DOF_APERTURE_FRACTION`) for a
  consistent f/2.8-equivalent depth of field across macro and full-board
  framings. A fine ± luminance grain (`GRAIN_AMOUNT`) is composited in the
  final blit via `renderToCanvasCallback`; it is seeded by the sample
  counter, so it shimmers faintly while converging and FREEZES with the
  held still. Raster modes stay pinhole-sharp and grain-free.
- **Unlit (MeshBasicMaterial) caveat**: the path tracer treats basic
  materials as roughness-0 mirrors. The unlit desk backdrop mirrored the
  HDRI softboxes as huge blown white blobs around the instruments — flag
  such meshes `userData.bbStudioMatte = true` and `studio.ts` swaps in a
  rough MeshStandardMaterial stand-in (same map/transparency) for the
  still, restored on dispose.
- **InstancedMesh is NOT expanded** by the library (a `InstancedMesh` bakes as
  a single copy at the object's transform). The board's per-hole collar/plug
  InstancedMeshes are therefore **baked by `studio.ts`** into temporary merged
  geometry for each BVH build, within a 1.5M-triangle budget (over-budget
  batches are simply omitted from the still). The bake writes transformed
  copies straight into ONE preallocated buffer per batch
  (`bakeInstancedMeshGeometry`, parity-tested in `tests/render-modes.test.ts`)
  — the old clone-per-instance + `mergeGeometries` bake cost 80–260 ms of
  synchronous main-thread time per rebuild on multi-board rigs. Only the
  channels the path tracer reads are baked (position/normal/tangent
  transformed; uv/color tiled). **`instanceColor` is ignored** by this bake —
  keep per-instance color out of board instancing, or flag the mesh
  `userData.bbNoStudio = true` to exclude it.
- **Excluded from the still automatically**: meshes with `ShaderMaterial` /
  `RawShaderMaterial` (holograms, hover-ring FX), `ShadowMaterial` (the desk
  shadow catcher), and any subtree flagged **`userData.bbNoStudio = true`**
  (the escape hatch asset/scene agents should use for screen-space or
  overlay-ish meshes). Non-mesh objects (sprites, lines, points) are ignored
  by the generator inherently.
- Lights: Directional/Point/Spot/RectArea lights are path-traced (the warm
  key + cool fill carry over); the HDRI environment supplies the rest.
- The path-traced image is a **still**: per-frame emissive animation (LED
  breathing) won't show while converged. The scene calls
  `modes.invalidate('materials')` when telemetry changes LED emissives —
  cheap (uniform re-upload, no BVH rebuild) but it restarts accumulation, so
  scene.ts throttles telemetry-driven refreshes to ~4Hz (the running sim
  pushes telemetry every frame).
- Studio's first frames blend: the path tracer rasterizes the Enhanced
  composer underneath and fades the accumulated image in (~350 ms) once it
  has ≥3 samples, so mode entry and re-convergence never flash.

## Perf discipline ledger

- One shadow map, on-demand: unchanged. Enhanced only resizes it (4096
  desktop) on activate and kicks a single `shadowMap.needsUpdate`.
- Transmission stays LEDs-only (asset rule — nothing here adds transmission).
- No per-frame allocations: composer passes allocate at construction;
  studio's motion guard uses preallocated matrices; the `progress` payload is
  a single reused object (documented on the event).
- pixelRatio cap ≤2 is inherited from the renderer everywhere (the composer
  mirrors `renderer.getPixelRatio()`; the path tracer synchronizes to the
  canvas size, scaled by the device base × the `STUDIO_PIXEL_BUDGET` clamp).
- Leaving Studio disposes the path tracer (BVH textures + accumulation
  targets are the biggest GPU allocations in the app). NOTE: 0.0.23's own
  `WebGLPathTracer.dispose()` throws on its first line (`this._renderQuad`;
  the field is `_quad`) and frees NOTHING — `studio.ts` therefore tears the
  internals down directly (`disposePathTracerDeep`: both internal
  PathTracingRenderers, their accumulation/blend/sobol targets, and every
  texture-bearing material uniform — BVH / attributes / materials / env-CDF
  — guarded against live app textures).
- Leaving Enhanced (→ Performance) releases its big HalfFloat targets
  (composer ping-pong, SAO, bloom mips — ~100 MB at 5.2 MP); a disposed
  render target re-allocates lazily on next use, so re-entry just pays a
  one-time re-alloc.
- A `webglcontextlost` (realistically: Studio's kernel hitting a GPU
  watchdog on huge canvases) is intercepted by the manager — preventDefault
  + session fallback to Enhanced instead of a dead canvas; the persisted
  mode choice is kept.
- While Studio drives an over-pixel-budget canvas (retina @2x), the
  Enhanced 4096 shadow bump is temporarily relaxed to the scene's native
  size (`setShadowRelaxed`) for ~130 MB of GPU headroom — the still's
  shadows are path-traced and only motion-fallback frames see the (approved
  Performance-look) 2048 map; Enhanced mode proper always keeps 4096.
  KNOWN LIMIT: desktop Studio on a 5.2 MP HEADED canvas remained an
  intermittent chromium GPU/renderer crash at baseline (4/4) and still
  crashes sometimes after the budget work (headless @2x and all @1x/phone
  runs converge reliably); the contextlost fallback covers the survivable
  cases.

## Files

- `capability.ts` — PURE node-tested logic: caps model, mode support/default/
  resolution, localStorage keys, budgets (render scale, shadow size, tiles,
  target samples) + `RENDER_MODES` picker metadata.
- `types.ts` — shared types (`RenderContext`, `StudioProgress`, event map).
- `manager.ts` — `RenderModeManager` facade (the only import scene.ts needs).
- `enhanced.ts` — lazy: HDRI env + composer stack pipeline.
- `studio.ts` — lazy: the only `three-gpu-pathtracer` importer.
- `bvh-worker.d.ts` — types for the three-mesh-bvh worker deep import.
- `tests/render-modes.test.ts` — selection/fallback/persistence logic, the
  lazy-import invariants, and the HDRI asset guard.

Visual tuning constants (SAO intensity/scale, bloom strength/threshold, HDRI
environment intensity, samples targets) sit at the top of `enhanced.ts` /
`capability.ts`, tuned against `scripts/modes.mjs` (`npm run build && node
scripts/modes.mjs` — the same blinky scene in all three modes, a converged
Studio close-up, an overlay-over-still proof, and network-level lazy-chunk
assertions; `MODES_ONLY=enhanced` etc. for single-section tuning loops).
