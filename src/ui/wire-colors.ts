/** The six wire colors offered in the toolbar swatch picker. */
export const WIRE_COLORS: { name: string; hex: string }[] = [
  { name: 'red', hex: '#e5484d' },
  { name: 'black', hex: '#1f232a' },
  { name: 'yellow', hex: '#e8c11c' },
  { name: 'green', hex: '#46a758' },
  { name: 'blue', hex: '#3e7bfa' },
  { name: 'white', hex: '#e8eaed' },
]

/** Display hex for a wire color name (falls back to the raw css value). */
export function wireColorHex(name: string | undefined): string {
  if (!name) return '#888c94'
  const found = WIRE_COLORS.find((c) => c.name === name)
  return found ? found.hex : name
}
