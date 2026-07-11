/**
 * Holographic placement-preview FX (pure helpers — no scene wiring here; the
 * scene integrator consumes these next phase).
 *
 * The ghost preview becomes a light-blue translucent hologram of the ACTUAL
 * component mesh: animated CRT scanlines scrolling slowly up in world-Y, a
 * fresnel rim glow, and a very subtle global flicker. Pin markers (glowing
 * ring + short light beam per target hole) show exactly where the legs land,
 * with a downward-travelling pulse in each beam so the pins read as "falling
 * into place".
 *
 * Intended scene usage:
 *
 *   // on ghost change (cheap — geometry is shared, materials are cached):
 *   const built = buildComponentObject(comp, entry, pinPositions)
 *   const holo = applyHologram(built.object, ok ? 'valid' : 'invalid')
 *   overlayGroup.add(holo)
 *   const markers = makePinMarkers(pinPositions, ok ? 'valid' : 'invalid')
 *   overlayGroup.add(markers.group)
 *
 *   // once per animation frame, before render (one number write):
 *   tickHolograms(elapsedSeconds)   // e.g. clock.getElapsedTime()
 *
 *   // honor prefers-reduced-motion (freezes scroll/flicker/pulse):
 *   setHologramReducedMotion(true)
 *
 *   // on ghost change / cancel:
 *   overlayGroup.remove(holo)       // clone shares geometry — nothing to free
 *   markers.dispose()
 *
 * Perf contract (README Known Issues / DESIGN.md §9): the two hologram
 * materials and the two marker material pairs are module-cached (page
 * lifetime, like meshes/shared.ts); all animation runs in the shaders off ONE
 * shared clock uniform, so per-frame JS cost is a single number assignment and
 * there are zero per-frame allocations. Hologram meshes never cast shadows
 * (the one shadow map stays clean) and are depth-tested but not depth-writing.
 */

import * as THREE from 'three'

export type HologramVariant = 'valid' | 'invalid'

/** Above components (0), selection (2) and the legacy ghost box (3). */
export const HOLOGRAM_RENDER_ORDER = 4
/** Pin marker rings draw over the hologram; beams over the rings (+1). */
export const PIN_MARKER_RENDER_ORDER = 5

/** Holographic cyan-blue for valid placements (DESIGN-adjacent teal-blue). */
const VALID_COLOR = 0x66ccff
/** iOS destructive red for invalid placements (DESIGN.md --ios-red). */
const INVALID_COLOR = 0xff453a

/** Base hologram opacity before scanline / fresnel / flicker contributions.
 *  (Raised from the blind-tuned 0.35 after the screenshot pass: over the
 *  bright ABS board an alpha-0.35 cyan washed out to near-invisible.) */
const BASE_OPACITY = 0.52
/** World-Y distance between scanlines, and their upward scroll speed (u/s). */
const SCANLINE_SPACING = 0.18
const SCANLINE_SPEED = 0.22
/** Height of the pin-marker light beams (short — just above leg tops). */
const BEAM_HEIGHT = 1.4
/** Marker ring/beam plan sizes (hole collar outer radius is 0.32). */
const MARKER_PLANE = 1.5
const BEAM_RADIUS_TOP = 0.17
const BEAM_RADIUS_BOTTOM = 0.12

// ---------------------------------------------------------------------------
// Shared animation clock (one uniform object referenced by every FX material)
// ---------------------------------------------------------------------------

const CLOCK: { value: number } = { value: 0 }
const REDUCED: { value: number } = { value: 0 }

/**
 * Advance every hologram/pin-marker shader. Call once per rendered frame with
 * **elapsed seconds since app start** (e.g. `THREE.Clock#getElapsedTime()` or
 * `performance.now() / 1000`). Costs one number write; allocation-free.
 */
export function tickHolograms(time: number): void {
  CLOCK.value = time
}

/**
 * `prefers-reduced-motion`: freezes the scanline scroll, the flicker and the
 * marker pulses (the hologram stays visible, just static).
 */
export function setHologramReducedMotion(reduced: boolean): void {
  REDUCED.value = reduced ? 1 : 0
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

/**
 * All fragment shaders end with the standard tonemapping/colorspace chunks so
 * the FX pass through the same ACES + sRGB pipeline as the rest of the scene
 * (ShaderMaterial output would otherwise bypass tone mapping and clash).
 */
const TONEMAP_FOOTER = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`

/** Hologram vertex: world position + normal (instancing-safe). */
const HOLO_VERT = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  void main() {
    vec3 pos = position;
    vec3 nrm = normal;
    #ifdef USE_INSTANCING
      pos = (instanceMatrix * vec4(pos, 1.0)).xyz;
      nrm = mat3(instanceMatrix) * nrm;
    #endif
    vec4 wp = modelMatrix * vec4(pos, 1.0);
    vWorldPos = wp.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * nrm);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

/**
 * Hologram fragment: translucent base + thin CRT scanlines every
 * SCANLINE_SPACING world units scrolling slowly upward + fresnel rim glow
 * (edges brighter, additive feel via >1 pre-tonemap color) + subtle global
 * sin flicker (±0.04 opacity, disabled by the reduced-motion uniform).
 */
const HOLO_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uReducedMotion;
  uniform float uOpacity;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  void main() {
    float anim = 1.0 - uReducedMotion;
    float t = uTime * anim;

    // scanlines: distance to the nearest line in line-spacing units
    float phase = (vWorldPos.y - t * ${SCANLINE_SPEED.toFixed(3)}) / ${SCANLINE_SPACING.toFixed(3)};
    float f = fract(phase);
    float line = smoothstep(0.14, 0.02, min(f, 1.0 - f));

    // fresnel rim (abs() so thin double-faced parts still rim correctly)
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float ndv = clamp(abs(dot(normalize(vWorldNormal), viewDir)), 0.0, 1.0);
    float fres = pow(1.0 - ndv, 2.5);

    // very subtle global flicker, +/-0.04 opacity
    float flicker = (0.6 * sin(t * 13.0) + 0.4 * sin(t * 29.3)) * 0.04 * anim;

    float alpha = clamp(uOpacity + 0.20 * line + 0.38 * fres + flicker, 0.0, 0.92);
    vec3 col = uColor * (1.05 + 0.9 * line + 1.5 * fres);
    gl_FragColor = vec4(col, alpha);
    ${TONEMAP_FOOTER}
  }
`

/** Flat marker-ring quad: radial LED-phosphor falloff, subtle pulse. */
const RING_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

const RING_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uReducedMotion;
  varying vec2 vUv;
  varying vec3 vWorldPos;
  void main() {
    float anim = 1.0 - uReducedMotion;
    float d = length(vUv - vec2(0.5)) * ${MARKER_PLANE.toFixed(2)};
    // world-position phase: shared material, per-hole pulse offset for free
    float pulse = 1.0 + 0.18 * anim * sin(uTime * 3.1 + vWorldPos.x * 1.3 + vWorldPos.z * 2.1);
    float core = exp(-pow((d - 0.34) / 0.07, 2.0));
    float halo = 0.45 * exp(-pow((d - 0.34) / 0.20, 2.0));
    float a = (core + halo) * pulse;
    gl_FragColor = vec4(uColor * a * 1.1, clamp(a, 0.0, 1.0));
    ${TONEMAP_FOOTER}
  }
`

/**
 * Beam: open-ended tapered cylinder, alpha fades with height and toward the
 * silhouette (soft volumetric look); a bright packet travels DOWN the beam so
 * the pins read as falling into the hole. Reduced motion = steady glow.
 */
const BEAM_VERT = /* glsl */ `
  varying float vY;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  void main() {
    vY = position.y;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

const BEAM_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uReducedMotion;
  uniform float uHeight;
  varying float vY;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  void main() {
    float anim = 1.0 - uReducedMotion;
    float hFrac = clamp(vY / uHeight, 0.0, 1.0);
    float vert = pow(1.0 - hFrac, 1.6);
    float phase = vWorldPos.x * 0.37 + vWorldPos.z * 0.61;
    float p = fract(uTime * 0.7 + phase);
    float center = (1.0 - p) * uHeight;
    float packet = 0.8 * exp(-pow((vY - center) / 0.22, 2.0));
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float ndv = clamp(abs(dot(normalize(vWorldNormal), viewDir)), 0.0, 1.0);
    float body = pow(ndv, 1.4);
    float a = (0.30 + anim * packet + (1.0 - anim) * 0.20) * vert * body;
    gl_FragColor = vec4(uColor * a, clamp(a, 0.0, 1.0));
    ${TONEMAP_FOOTER}
  }
`

// ---------------------------------------------------------------------------
// Material / geometry caches (page lifetime, like meshes/shared.ts)
// ---------------------------------------------------------------------------

function variantColor(variant: HologramVariant): THREE.Color {
  // THREE.Color converts hex into the linear working space (ColorManagement)
  return new THREE.Color(variant === 'valid' ? VALID_COLOR : INVALID_COLOR)
}

const holoMats = new Map<HologramVariant, THREE.ShaderMaterial>()
const ringMats = new Map<HologramVariant, THREE.ShaderMaterial>()
const beamMats = new Map<HologramVariant, THREE.ShaderMaterial>()
let ringGeo: THREE.PlaneGeometry | null = null
let beamGeo: THREE.CylinderGeometry | null = null

/**
 * The holographic preview material: translucent cyan-blue (valid) / red
 * (invalid) with scrolling CRT scanlines, fresnel rim and subtle flicker.
 * Cached per variant — the SAME instance is returned every call, so a ghost
 * rebuild costs no material compiles. Depth-tested, never depth-writing;
 * assign HOLOGRAM_RENDER_ORDER to meshes using it (applyHologram does).
 */
export function makeHologramMaterial(variant: HologramVariant): THREE.ShaderMaterial {
  let mat = holoMats.get(variant)
  if (!mat) {
    mat = new THREE.ShaderMaterial({
      vertexShader: HOLO_VERT,
      fragmentShader: HOLO_FRAG,
      uniforms: {
        uColor: { value: variantColor(variant) },
        uOpacity: { value: BASE_OPACITY },
        uTime: CLOCK,
        uReducedMotion: REDUCED,
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
    })
    mat.name = `hologram-${variant}`
    holoMats.set(variant, mat)
  }
  return mat
}

/** Raycast no-op: holograms/markers must never swallow scene picking. */
const noRaycast: THREE.Object3D['raycast'] = () => {}

/**
 * Clone `source` (a built component object) into its holographic ghost:
 * every mesh keeps its geometry (shared with the source — NOT copied) but
 * renders with the cached hologram material; lights, sprites (LED glow),
 * points and lines are stripped; shadows are disabled; nothing raycasts.
 *
 * Cheap to call on every ghost move/rotate. Discard by removing the clone
 * from its parent — it owns no GPU resources of its own (geometry belongs to
 * the source, the material is module-cached).
 */
export function applyHologram(source: THREE.Object3D, variant: HologramVariant): THREE.Object3D {
  const clone = source.clone(true)
  const material = makeHologramMaterial(variant)
  const doomed: THREE.Object3D[] = []
  clone.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh) {
      mesh.material = material
      mesh.castShadow = false
      mesh.receiveShadow = false
      mesh.renderOrder = HOLOGRAM_RENDER_ORDER
      mesh.raycast = noRaycast
    } else if (
      (o as THREE.Light).isLight ||
      (o as THREE.Sprite).isSprite ||
      (o as THREE.Points).isPoints ||
      (o as THREE.Line).isLine
    ) {
      doomed.push(o)
    }
    // the ghost must never be picked as a real component
    if (o.userData && 'componentId' in o.userData) delete o.userData.componentId
  })
  for (const o of doomed) o.parent?.remove(o)
  return clone
}

// ---------------------------------------------------------------------------
// Pin markers (ring + falling-light beam per target hole)
// ---------------------------------------------------------------------------

export interface PinMarkers {
  /** Add to the overlay group; positioned in world space already. */
  group: THREE.Group
  /** Detach + empty the group. Shared geometry/materials stay cached. */
  dispose(): void
}

function markerRingGeometry(): THREE.PlaneGeometry {
  if (!ringGeo) {
    ringGeo = new THREE.PlaneGeometry(MARKER_PLANE, MARKER_PLANE)
    ringGeo.rotateX(-Math.PI / 2)
  }
  return ringGeo
}

function markerBeamGeometry(): THREE.CylinderGeometry {
  if (!beamGeo) {
    beamGeo = new THREE.CylinderGeometry(
      BEAM_RADIUS_TOP,
      BEAM_RADIUS_BOTTOM,
      BEAM_HEIGHT,
      14,
      1,
      true, // open-ended: no hard caps in an additive volume
    )
    beamGeo.translate(0, BEAM_HEIGHT / 2, 0) // base at y = 0
  }
  return beamGeo
}

function markerRingMaterial(variant: HologramVariant): THREE.ShaderMaterial {
  let mat = ringMats.get(variant)
  if (!mat) {
    mat = new THREE.ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      uniforms: {
        uColor: { value: variantColor(variant) },
        uTime: CLOCK,
        uReducedMotion: REDUCED,
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    })
    mat.name = `pin-marker-ring-${variant}`
    ringMats.set(variant, mat)
  }
  return mat
}

function markerBeamMaterial(variant: HologramVariant): THREE.ShaderMaterial {
  let mat = beamMats.get(variant)
  if (!mat) {
    mat = new THREE.ShaderMaterial({
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      uniforms: {
        uColor: { value: variantColor(variant) },
        uHeight: { value: BEAM_HEIGHT },
        uTime: CLOCK,
        uReducedMotion: REDUCED,
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    })
    mat.name = `pin-marker-beam-${variant}`
    beamMats.set(variant, mat)
  }
  return mat
}

/**
 * Glowing target markers for the ghost's legs: a small pulsing ring + a short
 * additive light beam at each hole position (world space, y = hole top).
 * Animation is fully shader-side off the shared clock (`tickHolograms`).
 * Rebuild per ghost change is cheap: 2·N tiny meshes over cached resources.
 */
export function makePinMarkers(
  positions: ReadonlyArray<{ x: number; y: number; z: number }>,
  variant: HologramVariant,
): PinMarkers {
  const group = new THREE.Group()
  group.name = 'pin-markers'
  const ringMat = markerRingMaterial(variant)
  const beamMat = markerBeamMaterial(variant)
  const rGeo = markerRingGeometry()
  const bGeo = markerBeamGeometry()
  for (const p of positions) {
    const ring = new THREE.Mesh(rGeo, ringMat)
    ring.position.set(p.x, p.y + 0.06, p.z) // float just above the collar
    ring.renderOrder = PIN_MARKER_RENDER_ORDER
    ring.raycast = noRaycast
    const beam = new THREE.Mesh(bGeo, beamMat)
    beam.position.set(p.x, p.y + 0.02, p.z)
    beam.renderOrder = PIN_MARKER_RENDER_ORDER + 1
    beam.raycast = noRaycast
    // markers are world-positioned once and never move (all animation is
    // shader-side) — freeze their matrices so the per-frame auto-update
    // recompose is skipped (perf discipline, hotspots.md B2)
    ring.updateMatrix()
    ring.matrixAutoUpdate = false
    beam.updateMatrix()
    beam.matrixAutoUpdate = false
    group.add(ring, beam)
  }
  group.updateMatrix()
  group.matrixAutoUpdate = false
  return {
    group,
    dispose() {
      group.parent?.remove(group)
      group.clear()
    },
  }
}

/**
 * Free every module-cached hologram resource (materials + marker geometry)
 * and reset the caches. Only needed on full app teardown — the caches are
 * intentionally page-lifetime, mirroring meshes/shared.ts. Safe to call
 * repeatedly; the next makeHologramMaterial/makePinMarkers call recreates.
 */
export function disposeHolograms(): void {
  for (const m of holoMats.values()) m.dispose()
  for (const m of ringMats.values()) m.dispose()
  for (const m of beamMats.values()) m.dispose()
  holoMats.clear()
  ringMats.clear()
  beamMats.clear()
  ringGeo?.dispose()
  beamGeo?.dispose()
  ringGeo = null
  beamGeo = null
}
