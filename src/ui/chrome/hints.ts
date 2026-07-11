/**
 * hints.ts — one-line placement / wire-mode hint copy for the glass toast
 * pills above the dock. This is the old Palette footer hint logic (including
 * lead-by-lead progress) condensed to toast length.
 */
import { getEntry } from '../../model/catalog'
import type { InteractionMode } from '../../state/types'

/** Toast line for the current interaction mode, or null when none applies. */
export function hintForMode(mode: InteractionMode): string | null {
  switch (mode.kind) {
    case 'select':
      return null

    case 'wire':
      return mode.from
        ? `Wire from ${mode.from} — tap the second hole or terminal`
        : 'Wire mode — tap two holes or terminals to connect them'

    case 'place': {
      const entry = getEntry(mode.type)
      if (!entry) return `Unknown component type "${mode.type}"`
      switch (entry.placement) {
        case 'offboard':
          return `${entry.label} added beside the board — wire its terminals`
        case 'dip': {
          const n = entry.pins.length
          return `${entry.label}: tap the pin-1 hole in row f (DIP-${n} straddles the channel)`
        }
        case 'footprint': {
          const row = entry.footprintOffsets?.[0]?.row ?? 'f'
          return `${entry.label}: tap the ${entry.pins[0]} anchor hole (row ${row})`
        }
        case 'probe':
          return `${entry.label}: tap a hole on the net you want to plot`
        case 'leads': {
          const n = entry.pins.length
          const placed = mode.pickedHoles.length
          if (placed === 0) {
            return n === 1
              ? `${entry.label}: tap a hole to place it`
              : `${entry.label}: tap ${n} holes — pin order ${entry.pins.join(' → ')}`
          }
          const next = entry.pins[Math.min(placed, n - 1)]
          return `Lead ${Math.min(placed + 1, n)} of ${n} — tap the hole for '${next}'`
        }
      }
    }
  }
}
