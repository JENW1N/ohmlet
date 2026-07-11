/**
 * icons.tsx — SF-Symbols-style line icons for the kit. 24px grid, 1.8px
 * stroke, round caps/joins, stroke = currentColor so they tint with text
 * (e.g. --ios-blue on the active dock tab). Solid glyphs (play, bolt,
 * sparkles…) are filled with a thin matching outline to keep the optical
 * weight consistent with the line icons.
 *
 * Usage:
 *   <ChipIcon size={26} />        // dock "Parts" tab
 *   <TrashIcon size={20} />       // destructive ListRow leading slot
 */
import type { ReactNode } from 'react'

export interface IconProps {
  /** Square size in px. Default 24. */
  size?: number
}

function Glyph({ size = 24, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/** Parts — a DIP chip with pins (cpu). */
export function ChipIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
      <rect x="10.2" y="10.2" width="3.6" height="3.6" rx="0.9" />
      <path d="M9.5 6.5V3.9M14.5 6.5V3.9M9.5 20.1v-2.6M14.5 20.1v-2.6M6.5 9.5H3.9M6.5 14.5H3.9M17.5 9.5h2.6M17.5 14.5h2.6" />
    </Glyph>
  )
}

/** Wire — a curved jumper with bare ends. */
export function WireIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <path d="M5 17C10.6 17, 13.4 7, 19 7" />
      <circle cx="5" cy="17" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="19" cy="7" r="1.7" fill="currentColor" stroke="none" />
    </Glyph>
  )
}

/** AI — sparkles (one large + two small four-point stars). */
export function SparklesIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <path
        d="M9.5 4.5C10 7.6 11.9 9.5 15 10 11.9 10.5 10 12.4 9.5 15.5 9 12.4 7.1 10.5 4 10 7.1 9.5 9 7.6 9.5 4.5Z"
        fill="currentColor"
        strokeWidth={1}
      />
      <path
        d="M17.75 3.75c.27 1.62 1.23 2.58 2.85 2.85-1.62.27-2.58 1.23-2.85 2.85-.27-1.62-1.23-2.58-2.85-2.85 1.62-.27 2.58-1.23 2.85-2.85Z"
        fill="currentColor"
        strokeWidth={1}
      />
      <path
        d="M15.9 14.9c.23 1.36 1.04 2.17 2.4 2.4-1.36.23-2.17 1.04-2.4 2.4-.23-1.36-1.04-2.17-2.4-2.4 1.36-.23 2.17-1.04 2.4-2.4Z"
        fill="currentColor"
        strokeWidth={1}
      />
    </Glyph>
  )
}

/** Scope — oscilloscope trace. */
export function WaveformIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <path d="M2.75 12H6l3-6.5 6.3 13L18 12h3.25" />
    </Glyph>
  )
}

/** More — horizontal ellipsis. */
export function EllipsisIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <circle cx="5.2" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="18.8" cy="12" r="1.7" fill="currentColor" stroke="none" />
    </Glyph>
  )
}

export function PlayIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <path
        d="M8.5 5.6v12.8a1 1 0 0 0 1.53.85l10-6.4a1 1 0 0 0 0-1.7l-10-6.4a1 1 0 0 0-1.53.85Z"
        fill="currentColor"
        strokeWidth={1}
      />
    </Glyph>
  )
}

export function PauseIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <rect x="6.6" y="5.2" width="3.4" height="13.6" rx="1.5" fill="currentColor" stroke="none" />
      <rect x="14" y="5.2" width="3.4" height="13.6" rx="1.5" fill="currentColor" stroke="none" />
    </Glyph>
  )
}

export function ResetIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M19.85 3.7v4.35H15.5" />
    </Glyph>
  )
}

export function GearIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M12 2.9v2.5M12 18.6v2.5M2.9 12h2.5M18.6 12h2.5M5.57 5.57l1.77 1.77M16.66 16.66l1.77 1.77M18.43 5.57l-1.77 1.77M7.34 16.66l-1.77 1.77" />
    </Glyph>
  )
}

export function TrashIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <path d="M4.2 6.6h15.6" />
      <path d="M9.3 6.6V5c0-.83.67-1.5 1.5-1.5h2.4c.83 0 1.5.67 1.5 1.5v1.6" />
      <path d="M6.4 6.6l.85 12.1a1.9 1.9 0 0 0 1.9 1.77h5.7a1.9 1.9 0 0 0 1.9-1.77l.85-12.1" />
      <path d="M10.1 10.6v5.8M13.9 10.6v5.8" />
    </Glyph>
  )
}

export function PlusIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <path d="M12 5.2v13.6M5.2 12h13.6" />
    </Glyph>
  )
}

/** Internal companion to PlusIcon (used by Stepper). */
export function MinusIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <path d="M5.2 12h13.6" />
    </Glyph>
  )
}

export function CloseIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <path d="M6.4 6.4l11.2 11.2M17.6 6.4L6.4 17.6" />
    </Glyph>
  )
}

export function ChevronLeftIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <path d="M14.7 5.7L8.4 12l6.3 6.3" />
    </Glyph>
  )
}

export function ChevronRightIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <path d="M9.3 5.7l6.3 6.3-6.3 6.3" />
    </Glyph>
  )
}

export function ChevronUpIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <path d="M5.7 14.7L12 8.4l6.3 6.3" />
    </Glyph>
  )
}

export function ChevronDownIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <path d="M5.7 9.3l6.3 6.3 6.3-6.3" />
    </Glyph>
  )
}

export function CheckIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <path d="M4.8 12.6l4.7 4.7L19.2 7" />
    </Glyph>
  )
}

/** Import — arrow down into a tray. */
export function ImportIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <path d="M12 3.6v10.2M7.9 9.9l4.1 4.1 4.1-4.1" />
      <path d="M4.4 15.6v2.6a2 2 0 0 0 2 2h11.2a2 2 0 0 0 2-2v-2.6" />
    </Glyph>
  )
}

/** Export — arrow up out of a tray. */
export function ExportIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <path d="M12 13.8V3.6M7.9 7.7L12 3.6l4.1 4.1" />
      <path d="M4.4 15.6v2.6a2 2 0 0 0 2 2h11.2a2 2 0 0 0 2-2v-2.6" />
    </Glyph>
  )
}

export function BoltIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <path
        d="M12.8 2.8L5.4 13.2h4.9l-1.1 8 7.4-10.4h-4.9l1.1-8Z"
        fill="currentColor"
        strokeWidth={1}
      />
    </Glyph>
  )
}

export function LightbulbIcon({ size }: IconProps) {
  return (
    <Glyph size={size}>
      <path d="M12 2.9a6.1 6.1 0 0 0-3.6 11c.72.54 1.2 1.34 1.2 2.24v.36h4.8v-.36c0-.9.48-1.7 1.2-2.24a6.1 6.1 0 0 0-3.6-11Z" />
      <path d="M9.9 19.6h4.2M10.8 22h2.4" />
    </Glyph>
  )
}
