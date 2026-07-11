# Breadboard Studio — "Liquid Glass" Design Spec

The UI must feel like a **polished iOS app**, not a website: mobile-first,
touch-native, fluid, immediately understandable to a first-time user. This
document is binding for all UI work. Desktop is an adaptation of the phone
design, never the other way around.

## 1. Design language

**Material — Liquid Glass (WWDC25, not frosted blur).** Apple's words are
the bar: the chrome is "translucent and behaves like glass in the real
world — it reflects and refracts its surroundings… and dynamically reacts
to movement with specular highlights." Every chrome surface is a slab of
this meta-material floating over the live 3D scene. A flat blur is a
FAILED implementation. The system lives in `src/ui/kit/glass/` +
`kit.css`; this section is binding.

**The six signature behaviors (all shipped, all required):**

1. **Edge refraction (the lens).** The backdrop visibly BENDS around the
   surface's perimeter — wires/rails/holes curve into the rounded ends —
   while the center stays readable. Implementation: per-tier SVG
   displacement maps (rounded-rect SDF, outward normals in R/G around
   neutral 128, magnitude `(1-t)^2.2` across an 11–18px edge bezel; baked
   once at startup in `GlassDefs.tsx`) applied as
   `backdrop-filter: blur(12–16px) saturate(170%) url(#lg-lens-*)`.
   Chromium-only and therefore JS-gated by the `lg-lens-on` class on
   `<html>` — Safari/Firefox PARSE url() in backdrop-filter but drop the
   whole declaration at paint, so `@supports` must never gate this.
2. **The bent-light rim (all engines).** Every surface wears a 1.5px
   conic-gradient ring (bright at the key-light entry top-left, cool then
   warm fringes on the flanks) masked to the border, plus inset shadows
   giving the slab thickness: top `inset 0 1px 0 rgba(255,255,255,0.12)`,
   bottom `inset 0 -10px 22px -14px rgba(0,0,0,0.5)`, micro-rim
   `inset 0 0 0 0.5px rgba(255,255,255,0.05)`. This is what keeps the
   material reading as a lens even where displacement isn't available.
3. **Traveling specular highlight.** One shared rAF-throttled tracker
   (`glass/useSpecular.ts` — singleton listener, never per-component)
   writes `--lg-spec-x/y/o` on registered surfaces; a 220px radial
   gradient layer moves with transform only and its energy falls off over
   240px of pointer distance. Phones: deviceorientation drift where
   permission-free (Android), else a slow ambient sheen (`is-ambient`).
4. **Gel press.** Press = scale(0.96) within one frame AND the specular
   BLOOMS from the touch point (`gel.ts bloomAt`); release springs back
   with a 1.015 overshoot on the house curve (`gelRelease`). Controls opt
   in with `lg-gel` (PressableButton — all sizes, dock tabs, status
   capsule, part cards, chips, wire swatches, the Undo/Selection/Rotate
   pill buttons; see "Nested glass" below for the bloom-vs-release split).
5. **Morphing controls.** Surfaces transform, they don't pop:
   `glass/morph.ts` (FLIP scale/translate on the house spring —
   `captureRect` / `morphFromRect` / `morphFromElement` / `morphToRect`,
   plus the `setMorphOrigin`/`takeMorphOrigin` control→surface handoff)
   is the primitive for button→menu and control→sheet transitions.
   Shipped morphs: a dock tab records its rect on select and the sheet it
   summons CONDENSES out of it (FLIP from 45% of the way tab→sheet, 360ms,
   `composite:'add'` over the snap translate; Properties auto-present and
   dismissals keep the slide); the status capsule's expand/collapse is a
   fluid GROW (the incoming fixed-size pill layer FLIPs from the outgoing
   layer's rect under the 200ms crossfade); the dock's selection bubble is
   a specular-lit mini-lens that SLIDES (transform + @property-transitioned
   `--lg-dock-bub-x/y`, so its glint stays pinned under the pointer
   mid-slide). Reduced motion: every morph collapses to a crossfade.
6. **Backdrop adaptation (tone + shadows).** The material "knows how bright
   or dark the background is" (WWDC25-219): `glass/adapt.ts` samples the
   live WebGL scene behind each registered FLOATING platter (dock, status
   capsule, empty-state card — the tone tier) at ~2.6 Hz — one tiny strip
   blit + a single small `getImageData` per sample, scheduled from a timer
   task so its rAF lands right after `renderer.render()` while the drawing
   buffer is still valid (preserveDrawingBuffer stays off) — and writes
   two things per surface: `--lg-lum` (continuous 0–1 backdrop luminance;
   the registered `@property` transitions it, and the regular recipe's
   ambient shadow alpha is `calc(0.32 + lum × 0.35)` — Apple's "adaptive
   shadows", deeper over bright content) and `.is-tone-light` (hysteresis
   0.58 on / 0.46 off + a 2-sample vote): a LIGHT glass platter layer
   (`.lg-tone`, under rim/specular/content) fades in over the dark paint
   and every ink custom prop (`--label*`, `--separator`, `--lg-ink-shadow`)
   flips dark so the platter and its symbols stay visible over the key-lit
   board — independent of the app theme. Sheets, panels and nested cards
   are content surfaces and stay regular dark glass (like iOS sheets).
   Never engages under `prefers-reduced-transparency`; `?tone=off` is the
   verification flag. All-black readbacks (missed/paused frames) are
   detected and skipped, freezing the last tone.

**The regular recipe** (`.lg-surface`, the default "regular" variant —
adaptive dark glass, legible everywhere):

```css
background: linear-gradient(180deg, rgba(40,44,56,0.58), rgba(24,26,34,0.50));
backdrop-filter: blur(22px) saturate(180%);   /* lens tiers: 12–16px + url() */
border: 0.5px solid rgba(255,255,255,0.16);
box-shadow: 0 12px 40px rgba(0,0,0,calc(0.32 + var(--lg-lum,0.371)*0.35)),
            /* ^ adaptive ambient shadow: 0.45 at the neutral default */
            inset 0 1px 0 rgba(255,255,255,0.12),
            inset 0 -10px 22px -14px rgba(0,0,0,0.50),
            inset 0 0 0 0.5px rgba(255,255,255,0.05);
border-radius: var(--lg-radius-surface);       /* 22px */
text-shadow: var(--lg-ink-shadow);             /* adaptive ink, below */
```

Tone-adaptive platters (behavior 6) additionally carry the `.lg-tone`
light-glass child layer; in `.is-tone-light` the slab finish flips with it
(border 0.55 white, bright top inset, lighter thickness shadow, dock
bubble re-shaded as a dark chip).

**Clear variant** (`.lg-glass-clear`): permanently thinner glass with a
BAKED dimming layer (`rgba(10,12,18,0.24)` underneath) — the HIG demands
the dimmer or legibility collapses. Use ONLY over media-rich backdrops
with bold foreground (wire-color swatches; the mobile ActionSheet's cards,
whose always-on modal scrim supplies the rest of the dimming — desktop
ActionSheet panels present scrimless and go near-opaque instead, and a
mobile action sheet presented while a regular sheet is OPEN floats over
bright text rows, so its cards go alert-thick via the `body:has()` rule
in kit.css — no paint-only dim keeps 20px white ghosts unreadable); body
text stays on regular.
**Adaptive ink:** `--lg-ink-shadow` scales with transparency — 0.30 alpha
on regular, 0.55 on lensed, 0.65 on clear — so labels survive the bright
key-lit board.

**Concentric corners.** Nested radii share a center:
`child radius = parent radius − inset` (tokens `--lg-radius-surface` 22,
`--lg-radius-dock` 26, `--lg-radius-control` 9, `--lg-concentric-inset` 6;
utility `.lg-concentric`). Dock bubble = 26−6 = 20; segmented thumb =
9−2 = 7; **every in-sheet card** (inset lists, part cards, AI
prompt/result/status/error cards, scope window, burned banner) =
`--lg-radius-card` (22−6 = 16); text-input wells = `--lg-radius-field`
12; chips, search fields and floating pills are capsules (999). Never an
arbitrary inner radius.

**Nested glass (Tier S in practice).** Content INSIDE a lensed surface
wears the same material one slab thinner — never a flat fill or a plain
0.5px border. The `.lg-card` recipe (kit.css) = translucent gradient
tint + the SAME conic bent-light rim at reduced energy (the ring's stop
alphas are `--lg-rim-*` custom props shared with `.lg-surface::before`)
+ slab inset shadows, and NO backdrop-filter (the ≤4-blur budget lives
with the big surfaces). In-sheet ListGroups get it automatically
(`.lg-sheet .lg-list` / `.lg-panel .lg-list` in kit.css — the per-sheet
de-blur overrides are gone); part cards, AI cards and the floating
Undo/Selection/Rotate pills opt in with the class (the pills layer a
darker over-scene tint and 0.55-alpha ink — the luminance-adaptive label
treatment for chrome floating over the bright board; icons use the
drop-shadow form). Tinted variants (status blue, error/burned red, armed
blue) recolor the tint + micro-rim and keep the slab shadows. Text
fields are the INVERSE: recessed wells (dark fill + inset shadows, the
`.lg-well` recipe — same family as the switch/segmented/stepper/slider
tracks). Controls: the slider knob and segmented thumb carry the rim
ring; the knob holds a tiny TRACKED specular glint (cool-tinted so it
reads on white; refreshed by `bloomAt` during touch drags); wire
swatches render as glass beads (meniscus highlight, lit lip, shaded
base). Gel press is universal on interactives — md/lg buttons, part
cards and the chrome pill buttons bloom from the touch point
(`lg-specular lg-gel`); chips/swatches/sm buttons take `lg-gel` alone
(springy release; their `::after` is the 44px hit slot); the segmented
thumb squashes via `:has()`. Tracked-specular registrations stay small
(≤~5 concurrent): the big surfaces + the AI result card + visible
slider knobs.

**Surface tiers & budget (measured, binding).**
`scripts/glass-probe.mjs perf` over the live orbiting WebGL scene
(M4 Pro, ANGLE Metal, 1440×900): displacement lenses cost the SAME as
equivalent blur-only surfaces within noise — capsule-size ×6 p95 17.0ms
vs blur-only ×6 p95 16.7ms; the worst real stack (sheet + dock + capsule
lenses) p95 16.6ms vs 16.7ms blur-only ×3 — the orbit budget (§7) holds.
Re-measured after the chrome retrofit (`scripts/glass-chrome.mjs`, phone
emulation 390×844 @2x, date-display workload): orbit with the worst LIVE
stack (peek sheet band+body + dock + capsule) avg 10.8ms / p95 15.6 vs
baseline (dock + capsule) avg 11.0 / p95 16.8 — identical within noise.
The cost lives in the per-surface re-filter, not the displacement, so the
budget is structural, same as blur:

| Tier | Surfaces | Material |
|---|---|---|
| **L — lens** (≤3 concurrent, ≤1 band/sheet-size) | dock, status capsule (visible layer), the topmost regular sheet's 44px grabber BAND (mobile — its body is tier R; desktop panels lens whole), empty-state card | blur 12–16px + saturate + displacement, thinner paint |
| **R — rim+specular** | everything `.lg-surface` (incl. the mobile sheet body); toast pills and the dock's selection bubble carry rim + tracked specular WITHOUT any backdrop-filter | rim + inner shadows + (where registered) tracked specular; full 22px blur where not lens-gated |
| **S — static glass** | wire strip, undo pill, nested cards, ActionSheet's clear cards | rim + tint only, NO backdrop-filter (they stack) |

Filter ids = class names: `lg-lens-capsule` (220×44 nominal, bezel 11,
26px bend) · `lg-lens-dock` (372×61, 13, 30px) · `lg-lens-card`
(340×300, 16, 36px) · `lg-lens-sheet` (390×600, top corners only, 18,
40px) · `lg-lens-band` (390×44, top corners only, 12, 26px, FLAT-BOTTOM —
the bottom edge bakes neutral because it meets the sheet body's glass, not
the scene). Maps are objectBoundingBox-stretched, so off-nominal sizes
within ~±25% degrade gracefully; pick the nearest tier, never stretch
further.

**Fallback matrix.**

| Engine / setting | Material |
|---|---|
| Chromium | lens tiers (blur+saturate+displacement) + rim + specular |
| Safari / Firefox (or `?lens=off`, the verification flag) | rich blur 22px + saturate 180% + rim + specular (never `url()` — they'd drop the whole backdrop-filter) |
| `prefers-reduced-transparency` | near-opaque slabs, no backdrop-filter, lens never arms |
| `prefers-reduced-motion` | no ambient sheen drift, no gel overshoot, no morphs (crossfades); pointer-driven specular stays |

Rules: glass only on bounded surfaces (never a full-screen blur over the
WebGL canvas — it kills the GPU); cap blur at 22px (12–16px on lensed
surfaces); ≤4 concurrent backdrop-filters AND ≤3 concurrent lenses; max
3 glass layers stacked; displacement maps are baked once, never
per-frame; specular motion is transform/opacity only.

**Stacked regular sheets are RECESSED (enforced, not assumed).** Two
regular surfaces can be mounted at once — Parts open while a selection
auto-presents Properties (mobile peek→tap-a-part, or desktop marquee).
Sheet.tsx keeps a presentation stack and demotes every non-topmost
regular sheet/panel with `.lg-glass-recessed`: a recessed MOBILE sheet
(fully behind the topmost bottom sheet) drops band+body backdrop-filters
and goes near-opaque; a recessed DESKTOP panel (still visible beside the
topmost) keeps the rich 22px blur but sheds its url() lens. Promotion
back waits for the topmost sheet's real unmount, so exit animations never
overlap budgets. Worst reachable stacks land exactly on the caps: phone
recessed Parts (0) + topmost sheet at peek (band+body) + dock + capsule
= 4 filters / 3 lenses; desktop recessed panel + topmost panel + rail +
capsule = 4 filters / 3 lenses. `scripts/glass-chrome.mjs` asserts both
(checkVisibility-based audit — fixed-position surfaces included — with
hard ≤4/≤3 failures).

**Typography.** `font-family: -apple-system, BlinkMacSystemFont, system-ui,
'SF Pro Text', 'Segoe UI', Roboto, sans-serif`. Scale (px): LargeTitle 28/700,
Title 22/600, Headline 17/600, Body 17/400, Subhead 15/400, Caption 13/400,
Caption2 11/400. Letter-spacing −0.01em on titles. Numbers in readouts use
`font-variant-numeric: tabular-nums`.

**Color (iOS dark palette).** Canvas backdrop stays the 3D scene. Tokens:
`--ios-blue:#0A84FF --ios-green:#30D158 --ios-red:#FF453A --ios-orange:#FF9F0A
--ios-yellow:#FFD60A --ios-teal:#64D2FF --ios-purple:#BF5AF2
--label:rgba(255,255,255,0.92) --label-2:rgba(255,255,255,0.64)
--label-3:rgba(255,255,255,0.38) --separator:rgba(255,255,255,0.10)
--fill:rgba(120,120,128,0.24) --fill-2:rgba(120,120,128,0.16)`.
Accent = blue; Run = green; destructive = red.

**Motion.** One spring for everything: `cubic-bezier(0.32, 0.72, 0, 1)`.
Sheets/dock 380–450ms; controls 160–220ms; press feedback: `transform:
scale(0.96)` + slight dim, 120ms; gel release: 0.96 → 1.015 overshoot →
1.0 over 280ms (`gelRelease`). Surface transitions prefer MORPHS
(`glass/morph.ts`) over mount/unmount pops. Sheets slide from the bottom
with a subtle parallax dim of the scene (rgba black 0→0.25, NO blur).
Honor `prefers-reduced-motion: reduce` (crossfade instead of slide, no
ambient sheen, no overshoot). Animate ONLY transform/opacity. Everything
interactive must respond on pointerdown (within one frame), not on click.

**Haptics.** `navigator.vibrate?.(8)` on: placement commit, wire complete,
Run/Pause, delete, sheet snap. Silently no-op elsewhere.

## 2. App structure (phone portrait, the primary layout)

- **3D canvas full-bleed** edge to edge, under everything (`100dvh`).
- **Status capsule** — top center floating glass pill (Dynamic-Island-like):
  run state dot (green pulsing when running), sim clock, tap = Run/Pause,
  long-press = Reset. Expands briefly to show issues/AI status as they occur
  (auto-collapse 3s). Respects `env(safe-area-inset-top)`.
- **Dock** — bottom floating glass tab bar, 5 tabs with SF-style line icons +
  11px labels: **Parts · Wire · AI · Scope · More**. Active tab: filled icon,
  blue tint, springy selection bubble behind it. Sits above
  `env(safe-area-inset-bottom)`.
  - *Parts* → Parts sheet. *Wire* → enters wire mode (tab stays "armed" with
    color swatch row appearing above the dock; tap again to exit). *AI* → AI
    sheet. *Scope* → Scope sheet (half-height). *More* → settings/import/
    export/clear/examples action list, the Graphics (render-mode) picker,
    and the board controls: size picker plus Boards/Rows steppers for the
    2-D grid (6 wide × 4 deep max). In the 3D scene the same growth is a
    "+" glass grow paddle floating at each edge of the grid (select mode,
    sim stopped, hidden at the axis cap) — tapping one springs the new
    module/row in.
- **Bottom sheets** — the universal container (Parts, AI, Scope, Properties,
  More, dialogs): grabber handle, three snap points (peek 28%, half 55%,
  full 92%), drag with rubber-banding, swipe-down or scrim-tap to dismiss,
  spring physics (implement with pointer events + transform, no library).
  Content scrolls only when the sheet is at full.
- **Properties sheet** auto-presents (half) when a component is selected:
  big title (label + id), param controls, hole info, red "Remove" row.
- **Run FAB**: none — the status capsule is the run control (keeps the canvas
  clean). Placement/wire hints appear as a small glass toast above the dock.
- **Empty state**: friendly overlay card — "Build your first circuit" with
  two big buttons: "Browse parts" and "✨ Ask AI" (opens AI sheet, prompt
  prefilled with the date-display example).
- **Onboarding**: first launch only (localStorage flag), 3-step coach marks
  (rotate/zoom gestures, parts, AI). Skippable, 3 dots, springy.

## 3. Controls (iOS-equivalent components, hand-rolled)

- **Switch**: 51×31 track, 27px knob with shadow, green when on, knob slides
  with spring; used for all booleans.
- **Segmented control**: glass track, sliding selection thumb (used for sim
  speed, scope window, waveform).
- **Slider**: 28px touch knob, value bubble while dragging (pot position,
  light level, voltage).
- **Stepper + numeric field** for precise values; resistor gets an E12
  horizontal chip-scroller (220Ω 330Ω 470Ω 1k …).
- **List rows**: inset grouped style — glass card, 44px+ rows, separators
  inset 16px, chevrons, press highlight.
- **Buttons**: pill (filled blue / tinted / plain); destructive = red tinted.
- **Pushbutton part** gets a giant circular "HOLD" button in Properties.
- **Action sheet** (long-press a component on canvas): Properties / Duplicate
  / Delete — bottom action sheet with red Delete + Cancel.
- **Toasts**: top capsule expansion (status) or small glass pill above dock.

## 4. Touch & canvas interaction

- Pointer Events everywhere (`pointerdown/move/up`, `setPointerCapture`);
  never rely on hover for affordances; hover effects are progressive
  enhancement behind `@media (hover: hover)`.
- OrbitControls: `touches: { ONE: ROTATE, TWO: DOLLY_PAN }`; damped; tap =
  moved < 10px && < 350ms; long-press 500ms (with 10px tolerance) = action
  sheet; double-tap empty space = re-frame board.
- Hole snap radius 0.55 units with mouse, **0.9 with coarse pointers**
  (`pointerType === 'touch'`); during placement/wiring show a magnified
  ghost-cursor ring above the fingertip (offset +2.5 units toward camera top)
  so the finger doesn't hide the target hole.
- **Hover-ring motion spec (user-tuned, binding):** brightness MODEST — a
  soft LED-phosphor glow, clearly visible but never a beacon (if it reads as
  "bright" at arm's length, it's too hot; dial emissive down). The
  personality comes from MOTION, not luminance: on arriving at a hole the
  ring pops in with a springy scale overshoot (~0.6 → ~1.12 → settle 1.0 on
  the house spring, ≤220ms) plus a one-shot subtle squash-and-stretch (a
  hair wider than tall on landing, then relax) — "squishy", quirky-but-cool,
  NOT bouncy-cartoon. Hopping between adjacent holes retriggers a smaller
  version of the pop (~1.06 overshoot). While resting: the existing gentle
  breathing glow, low amplitude. On leave: quick fade, no animation.
  Reduced-motion: crossfade only.
- Canvas element: `touch-action: none`. UI chrome: `touch-action:
  manipulation`, `-webkit-tap-highlight-color: transparent`,
  `user-select: none`, `overscroll-behavior: none` on body.
- 44px (≈44pt) minimum touch target on every control. Dock icons 28px in a
  49px bar + labels.

## 4b. Routing & collision acceptance (user-reported, BINDING)

Zero interpenetration is the bar — judged from rendered close-ups, not code.
The specific scenarios the user has reported and that MUST hold:

- **Adjacent identical parts at 1-column spacing** (two+ resistors, LEDs, or
  capacitors in neighboring columns, parallel spans): bodies must not touch.
  Resolution geometry: raise the body height tier AND bend the legs INWARD
  toward the body axis (hairpin profile) so packed parts nest like a real
  dense build — do not just fan them apart laterally into other conflicts.
- **Legs are colliders too**: resistor/LED/leaded-part legs (the full bent
  lead path, not just the body) must respect obstacle boxes — no prong may
  pass through a DIP switch, pushbutton, pot, display, or any boxy part.
- **Obstacle boxes must match the CURRENT meshes**: whenever a part's visual
  extents change (e.g. the Phase-C asset redo), the router obstacle rects and
  occlusion footprints must be re-synced to the new geometry.
- **Wire-wire**: no two wires may intersect anywhere in the dense examples
  (date-display, counter) or a generated 50-wire stress board.
- **Instrument bodies** (PSU, function gen) are router obstacles; wires from
  their own terminals exit cleanly away from the box face.
- Acceptance check: dense-layout close-ups from at least 3 angles with every
  part type adjacent-packed at 1-column spacing; any visible overlap of any
  two rendered elements = failing.

## 5. App-ness (PWA / iOS install polish)

- `index.html`: `<meta name="viewport" content="width=device-width,
  initial-scale=1, viewport-fit=cover, user-scalable=no">`; `theme-color`
  #15171c; `apple-mobile-web-app-capable` + black-translucent status bar;
  apple-touch-icon (generate a simple breadboard glyph SVG→PNG 180px or
  inline SVG icon file).
- `public/manifest.webmanifest`: standalone display, dark colors, icons.
- Use `100dvh`/`100dvw`; every floating element respects safe-area insets.
- No page scrolling, ever: `position: fixed` app shell.

## 6. Responsive adaptation (tablet / desktop ≥ 900px)

Same components, same glass: dock becomes a **left vertical glass rail**;
sheets become **floating glass panels** anchored left (Parts) / right
(Properties, AI) with the same springs; status capsule stays top-center;
Scope docks bottom-right as a card. Pointer hover states activate. Keyboard
shortcuts (Esc, Delete, Space = run/pause) active on desktop.

## 7. Performance budget

60fps interactions on a mid-range phone: animate only transform/opacity;
backdrop-filter limited to ≤4 surfaces; rAF-driven sheet drag (no per-move
React state — direct style writes, commit state on release); React renders
throttled (sim telemetry → UI at ≤10Hz; canvas overlays via refs);
`content-visibility: auto` on closed-sheet content; renderer pixelRatio
≤ 2; pause the render loop entirely when tab hidden.

**Render budgets (Phase D — measured on the date-display reference
workload, 37 parts / 42 wires, via `scripts/perf.mjs`; enforced by code
discipline + the perf probe, not by tests):**

- **Draw calls/frame** (reference workload): Performance ≤ ~320, Enhanced
  ≤ ~530 (SAO pre-pass included). Held by: one merged mesh per wire,
  `matrixAutoUpdate = false` on static subtrees (matrices set once at
  build/move-commit), `BatchedMesh`/merged statics for repeated parts, and
  the board's three-InstancedMesh hole sockets.
- **Orbit gesture**: zero frames > 33 ms in every mode; hover raycasts are
  GATED OFF while OrbitControls is interacting (re-armed on release);
  first-use shaders (hover ring, label chip, hologram, composer) are
  pre-warmed at mount so no program links land mid-gesture (Performance
  0 links; Enhanced has 2 residual first-orbit links — known issue).
- **Enhanced compositing**: SAO runs at **½ resolution** (pixel-unit params
  rescaled, linear-filtered composite) and its normal/depth pre-pass skips
  a cached list of meshes that cannot affect the AO term; bloom mip chain
  and SMAA at full res; still exactly ONE on-demand shadow map (4096
  desktop / 2048 phone).
- **Studio**: internal trace resolution clamped by `STUDIO_PIXEL_BUDGET`
  (~2.6 MP — a 5.2 MP retina canvas traces at ~0.71×, preventing the GPU
  process crash); per-rAF tile bursts capped by `STUDIO_TILE_PIXEL_BUDGET`
  (180 k px) with a finer restart ladder for the first samples after a
  settle (re-convergence p95 ~16.6 ms, jank 26 → 3–6 frames); target
  samples 320 desktop / 120 phone; `webglcontextlost` falls back to
  Enhanced for the session.
- **Measured gate** (M4 Pro reference, 120 Hz vsync cap): all modes orbit
  AT the 120 fps cap, desktop and phone-emulation, p95 ≤ ~10 ms (baseline:
  Enhanced @2x was 74.9 fps / p95 17.7 ms). Capped rows mean "fits the
  budget on an M4 Pro" — the transferable signals are draws/frame, alloc
  KB/frame and pass costs. Numbers: `perf/final.md` + the final-gate
  artifacts in `perf/`.

## 8. Acceptance checklist (the redesign is done when…)

- [ ] On a 390×844 viewport everything is reachable one-handed; no control
      under 44px; nothing overlaps the home indicator or notch.
- [ ] Placement, wiring, properties editing, AI generate→apply, import/
      export, scope — all completable with touch only (verified by
      code-trace + Playwright-style viewport reasoning).
- [ ] Sheets spring, drag, snap and dismiss like iOS; press states on every
      control; zero hover-only affordances on touch.
- [ ] Liquid-glass surfaces over the live 3D scene; no full-screen blurs;
      60fps reasoning documented.
- [ ] Desktop ≥900px gets the rail+panel adaptation, nothing broken.
- [ ] `npm run build` + full test suite stay green (UI changes must not
      touch sim/model/llm logic except where the contract demands).

## 9. Rendering (3D scene pipeline)

The scene aims for a **product photo of a real breadboard on a desk**, not a
toy render — while staying inside the phone budget (§7). Owned by
`src/three/scene.ts` + `src/three/internal/board.ts`.

**Render modes.** This section specifies the BASELINE raster pipeline —
what ships as the **Performance** mode (the phone default; zero added
cost). Two richer modes layer on top of the same scene graph without
forking it: **Enhanced** (HDRI IBL + SAO/bloom/SMAA composer, the desktop
default) and **Studio** (progressive path tracing for converged stills,
with live raster overlays composited on top). Their full spec — pipelines,
budgets, lazy-chunk rules, material caveats, HDRI/pathtracer credits — is
`src/three/render-modes/RENDER-MODES.md`; the perf rules in §7 and the
one-shadow-map discipline below bind ALL modes.

**Pipeline.** `outputColorSpace: SRGBColorSpace`, `ACESFilmicToneMapping` at
exposure **1.05**. Image-based lighting: `PMREMGenerator` +
`RoomEnvironment` → `scene.environment`, `environmentIntensity 0.85` — this
is what makes the PBR metals / molded epoxy / LED glass read. No
postprocessing, pixelRatio cap stays ≤ 2, render loop still pauses when the
tab is hidden.

**Lights.** One warm key `DirectionalLight` (#fff0dd, 1.2) — the **single
shadow caster** (PCFSoft, one 2048 map, bias −0.0002 / normalBias 0.02) —
plus a dim cool fill (#bcd0ff, 0.22). No hemisphere/ambient lights (they wash
the IBL flat). The key's orthographic shadow camera is fitted to the active
board + instrument extents and **refits on board-size change** (texel density
rises on smaller boards; nothing clips on Lab XL).

**Shadows.** Opaque component meshes, wires and terminal posts cast only
(transparent parts — LED glass, glows, labels — are skipped); the board casts
and receives. The desk is a large LIT laminate plane (procedural walnut
color + roughness pair, repeating; non-repeating radial alpha rim fade) that
receives the key-light shadow physically, so parts feel seated on a real
surface. Exactly one shadow map total.

**Board realism** (`board.ts`, size-aware via `boardExtents(size)` /
`allHoles(size)`): molded-ABS `MeshPhysicalMaterial` (clearcoat 0.2, shared
procedural noise normal map), body slabs extruded with rounded outer corners
and edge fillets, recessed center channel, and TRUE recessed hole sockets —
a square bore is **punched through every slab's top face** (Shape.holes on
the extrusion: the face stays flush, like a real board) with three
InstancedMeshes descending inside each bore (BackSide chamfer funnel, dark
tapering shaft, metal contact plug), and one
full-board decal (CanvasTexture color + bump pair on a lit material):
painted rail-stripe grooves with lip shading, AO-style darkening around
every hole, printed legend, and an embossed `BREADBOARD STUDIO` + size brand.

**Board sizes & the 2-D grid.** `scene.setLayout` reads the full rig
(`boardConfigOf(layout)`: size preset × modules wide × board-rows deep);
when any of the three differs from the built board it disposes and rebuilds
the board mesh, rebuilds the hole index (`hole-index.ts` is rig-aware),
recenters the desk, recomputes the home framing and refits the shadow
camera. Side-by-side modules butt at visible seams with continuous painted
rails; board-rows sit 19.5 units apart (one row's full mesh depth — rows
abut, their edge fillets meeting in a shallow seam V) with their own
rails. New modules/rows spring in when grown from a paddle.
Home/content framing always follow the *active* extents.

**Tuning rule.** If screenshots show the glass chrome washing out over the
brighter scene, nudge `EXPOSURE` / `ENV_INTENSITY` / `KEY_INTENSITY` in
scene.ts — never the UI. Verify with `npm run build && node
scripts/screenshot.mjs` (plus `scripts/screenshot-boards.mjs` for board-size
close-ups) and view the `shots/*.png`.
