/**
 * Number/value formatting helpers shared by the UI panels.
 */

const ENG_PREFIXES: Record<number, string> = {
  [-12]: 'p',
  [-9]: 'n',
  [-6]: 'µ',
  [-3]: 'm',
  0: '',
  3: 'k',
  6: 'M',
  9: 'G',
}

/** Engineering notation: 4700 → "4.7 kΩ", 1e-5 → "10 µF". */
export function fmtEng(value: number, unit = ''): string {
  if (!Number.isFinite(value)) return '—'
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  if (abs === 0) return unit ? `0 ${unit}` : '0'
  let exp = Math.floor(Math.log10(abs) / 3) * 3
  exp = Math.max(-12, Math.min(9, exp))
  let mant = abs / Math.pow(10, exp)
  // guard against rounding pushing the mantissa to 1000
  if (mant >= 999.5 && exp < 9) {
    exp += 3
    mant = abs / Math.pow(10, exp)
  }
  const digits = mant >= 100 ? 0 : mant >= 10 ? 1 : 2
  let s = mant.toFixed(digits)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  const suffix = `${ENG_PREFIXES[exp] ?? ''}${unit}`
  return suffix ? `${sign}${s} ${suffix}` : `${sign}${s}`
}

/** Voltage readout: 3.3012 → "3.30 V", 0.012 → "12 mV". */
export function fmtVolts(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 100) return `${v.toFixed(0)} V`
  if (a > 0 && a < 1) return `${(v * 1000).toFixed(0)} mV`
  return `${v.toFixed(2)} V`
}

/** Clamp helper used by parameter editors. */
export function clamp(n: number, min?: number, max?: number): number {
  let out = n
  if (min !== undefined && out < min) out = min
  if (max !== undefined && out > max) out = max
  return out
}

/** Coerce a ParamValue-ish to a finite number with fallback. */
export function toNumber(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}
