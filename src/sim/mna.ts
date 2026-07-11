/**
 * Dense nodal-analysis solver (Norton-only stamps) for the simulator.
 * Owned by the sim-core agent.
 *
 * The matrix is a pure conductance matrix: every source is stamped as a
 * Norton equivalent (G += 1/rout, I += v/rout). No group-2 voltage-source
 * rows exist. A gmin leak (1e-9 S) from every node to ground keeps floating
 * nets from making the matrix singular.
 *
 * Nonlinear devices iterate Newton-Raphson around the solve: each iteration
 * the devices restamp their linearized companions at the current candidate
 * solution (with pn-junction voltage-step limiting via `pnLimit`).
 *
 * Linear circuits factor once: `factorIfNeeded()` compares the freshly
 * stamped matrix to the last factored one and reuses the LU decomposition
 * when nothing changed (only forward/back substitution runs per step).
 */

/** Leak conductance from every node to ground (S). */
export const GMIN = 1e-9
/** Maximum Newton-Raphson iterations per solve. */
export const NR_MAX_ITERS = 40
/** Newton-Raphson absolute convergence tolerance (V). */
export const NR_TOL = 1e-6
/** Maximum pn-junction voltage step per NR iteration (V). */
export const PN_MAX_STEP = 0.5

/**
 * SPICE-style junction voltage limiting: clamp the change of a junction
 * voltage between NR iterations to ±maxStep so the exponential diode law
 * cannot explode. Returns the limited voltage.
 */
export function pnLimit(vNew: number, vOld: number, maxStep: number = PN_MAX_STEP): number {
  const dv = vNew - vOld
  if (dv > maxStep) return vOld + maxStep
  if (dv < -maxStep) return vOld - maxStep
  return vNew
}

/**
 * Stamping interface handed to devices/chips. Node index -1 means ground
 * (the reference): stamps touching ground rows/columns are silently dropped,
 * which is exactly the reduced-MNA behavior.
 */
export interface StampContext {
  readonly nodeCount: number
  /** Raw matrix element: A[row][col] += value (skipped for ground nodes). */
  addElement(row: number, col: number, value: number): void
  /** Two-terminal conductance g between nodes a and b. */
  addConductance(a: number, b: number, g: number): void
  /** Independent current source injecting `current` amps INTO `node`. */
  addCurrent(node: number, current: number): void
  /** Thevenin source {v, rout} between plus and minus, stamped as a Norton. */
  addNorton(plus: number, minus: number, v: number, rout: number): void
}

const SINGULAR_EPS = 1e-13

export class MnaSystem implements StampContext {
  readonly nodeCount: number

  /** workspace for NR (the "next" candidate solution) */
  readonly scratch: Float64Array

  private readonly a: Float64Array // stamped conductance matrix (row-major)
  private readonly b: Float64Array // stamped RHS current vector
  private readonly lu: Float64Array // LU factors (in place, unit lower diag)
  private readonly luSrc: Float64Array // copy of the matrix that was factored
  private readonly perm: Int32Array // row-swap record from partial pivoting
  private hasFactor = false

  constructor(nodeCount: number) {
    const n = Math.max(0, nodeCount | 0)
    this.nodeCount = n
    this.a = new Float64Array(n * n)
    this.b = new Float64Array(n)
    this.lu = new Float64Array(n * n)
    this.luSrc = new Float64Array(n * n)
    this.perm = new Int32Array(n)
    this.scratch = new Float64Array(n)
  }

  /** Reset matrix and RHS for a fresh stamping pass (gmin on the diagonal). */
  beginStamp(): void {
    const n = this.nodeCount
    this.a.fill(0)
    this.b.fill(0)
    for (let i = 0; i < n; i++) this.a[i * n + i] = GMIN
  }

  addElement(row: number, col: number, value: number): void {
    if (row >= 0 && col >= 0) this.a[row * this.nodeCount + col] += value
  }

  addConductance(a: number, b: number, g: number): void {
    const n = this.nodeCount
    if (a >= 0) this.a[a * n + a] += g
    if (b >= 0) this.a[b * n + b] += g
    if (a >= 0 && b >= 0) {
      this.a[a * n + b] -= g
      this.a[b * n + a] -= g
    }
  }

  addCurrent(node: number, current: number): void {
    if (node >= 0) this.b[node] += current
  }

  addNorton(plus: number, minus: number, v: number, rout: number): void {
    const r = rout > 1e-6 ? rout : 1e-6
    const g = 1 / r
    this.addConductance(plus, minus, g)
    this.addCurrent(plus, v * g)
    this.addCurrent(minus, -v * g)
  }

  /**
   * Factor the stamped matrix with LU + partial pivoting, unless it is
   * bit-identical to the last factored matrix (then the old factorization is
   * reused — linear circuits factor once). Returns false if singular.
   */
  factorIfNeeded(): boolean {
    const n = this.nodeCount
    if (n === 0) return true
    const a = this.a
    const luSrc = this.luSrc

    if (this.hasFactor) {
      let same = true
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== luSrc[i]) {
          same = false
          break
        }
      }
      if (same) return true
    }

    luSrc.set(a)
    const lu = this.lu
    lu.set(a)
    const perm = this.perm

    for (let k = 0; k < n; k++) {
      // partial pivoting: pick the largest |entry| in column k at/below row k
      let p = k
      let max = Math.abs(lu[k * n + k])
      for (let i = k + 1; i < n; i++) {
        const v = Math.abs(lu[i * n + k])
        if (v > max) {
          max = v
          p = i
        }
      }
      if (!(max > SINGULAR_EPS)) {
        this.hasFactor = false
        return false
      }
      perm[k] = p
      if (p !== k) {
        for (let j = 0; j < n; j++) {
          const t = lu[k * n + j]
          lu[k * n + j] = lu[p * n + j]
          lu[p * n + j] = t
        }
      }
      const pivInv = 1 / lu[k * n + k]
      for (let i = k + 1; i < n; i++) {
        const m = lu[i * n + k] * pivInv
        lu[i * n + k] = m
        if (m !== 0) {
          for (let j = k + 1; j < n; j++) lu[i * n + j] -= m * lu[k * n + j]
        }
      }
    }
    this.hasFactor = true
    return true
  }

  /** Solve A x = b using the current factorization, writing into `x`. */
  solveInto(x: Float64Array): void {
    const n = this.nodeCount
    if (n === 0) return
    if (!this.hasFactor) return
    const lu = this.lu
    const perm = this.perm
    x.set(this.b)
    // apply recorded row swaps
    for (let k = 0; k < n; k++) {
      const p = perm[k]
      if (p !== k) {
        const t = x[k]
        x[k] = x[p]
        x[p] = t
      }
    }
    // forward substitution (L has unit diagonal)
    for (let i = 1; i < n; i++) {
      let s = x[i]
      const row = i * n
      for (let j = 0; j < i; j++) s -= lu[row + j] * x[j]
      x[i] = s
    }
    // back substitution
    for (let i = n - 1; i >= 0; i--) {
      let s = x[i]
      const row = i * n
      for (let j = i + 1; j < n; j++) s -= lu[row + j] * x[j]
      x[i] = s / lu[row + i]
    }
  }
}

export interface NewtonResult {
  converged: boolean
  iterations: number
  singular: boolean
}

/**
 * Newton-Raphson outer loop. `stampAll(x)` must restamp every device at the
 * candidate solution `x` (devices apply their own junction limiting and
 * remember the limited operating point between iterations).
 *
 * `x` is used as the initial guess and receives the final solution.
 */
export function solveNewton(
  sys: MnaSystem,
  stampAll: (x: Float64Array) => void,
  x: Float64Array,
  maxIter: number = NR_MAX_ITERS,
  tol: number = NR_TOL,
): NewtonResult {
  const n = sys.nodeCount
  if (n === 0) return { converged: true, iterations: 0, singular: false }
  const xNext = sys.scratch

  for (let iter = 1; iter <= maxIter; iter++) {
    sys.beginStamp()
    stampAll(x)
    if (!sys.factorIfNeeded()) {
      return { converged: false, iterations: iter, singular: true }
    }
    sys.solveInto(xNext)

    let maxDelta = 0
    for (let i = 0; i < n; i++) {
      const d = Math.abs(xNext[i] - x[i])
      if (d > maxDelta) maxDelta = d
    }
    x.set(xNext)
    if (maxDelta < tol) return { converged: true, iterations: iter, singular: false }
    if (!Number.isFinite(maxDelta)) return { converged: false, iterations: iter, singular: false }
  }
  return { converged: false, iterations: maxIter, singular: false }
}
