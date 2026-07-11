/**
 * hooks.ts — small environment hooks shared by all kit components.
 *
 * Usage:
 *   const isDesktop = useIsDesktop()            // >= 900px → rail + panels
 *   const coarse = useCoarsePointer()           // touch → bigger snap radii
 *   const { bottom } = useSafeAreaInsets()      // px numbers from env()
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'

/** Reactive media-query hook (SSR-safe, subscribes to changes). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => {}
      }
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    [query],
  )
  const getSnapshot = useCallback(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(query).matches,
    [query],
  )
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

/** Tablet/desktop adaptation breakpoint (DESIGN.md §6). */
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 900px)')
}

/** True for touch-first devices (fat-finger snap radii, no hover). */
export function useCoarsePointer(): boolean {
  return useMediaQuery('(pointer: coarse)')
}

export interface SafeAreaInsets {
  top: number
  right: number
  bottom: number
  left: number
}

const ZERO_INSETS: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 }
let cachedInsets: SafeAreaInsets | null = null

/**
 * Read the env(safe-area-inset-*) values as pixel numbers by measuring a
 * throwaway probe element once (result is cached for the session). Prefer
 * the CSS utilities (.lg-safe-bottom / var(--lg-safe-*)) for layout; use
 * this only where JS math needs the numbers (e.g. ActionSheet sizing).
 */
export function readSafeAreaInsets(): SafeAreaInsets {
  if (cachedInsets) return cachedInsets
  if (typeof document === 'undefined' || !document.body) return ZERO_INSETS
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;' +
    'padding-top:env(safe-area-inset-top,0px);' +
    'padding-right:env(safe-area-inset-right,0px);' +
    'padding-bottom:env(safe-area-inset-bottom,0px);' +
    'padding-left:env(safe-area-inset-left,0px);'
  document.body.appendChild(probe)
  const cs = getComputedStyle(probe)
  cachedInsets = {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  }
  probe.remove()
  return cachedInsets
}

/** Hook form of readSafeAreaInsets() (measured once, cached). */
export function useSafeAreaInsets(): SafeAreaInsets {
  return useMemo(readSafeAreaInsets, [])
}
