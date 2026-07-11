/**
 * toasts.ts — imperative toast API. Call showToast() from anywhere (store
 * actions, event handlers); <ToastHost/> (Toast.tsx) renders the queue as
 * small glass pills above the dock. At most 2 toasts are queued — older
 * ones are pushed out gracefully.
 *
 * Usage:
 *   showToast('Wire connected')
 *   showToast('LED burned out', { duration: 3500, icon: <BoltIcon size={16}/> })
 */
import type { ReactNode } from 'react'

export interface ToastOptions {
  /** Auto-dismiss after this many ms. Default 2200. */
  duration?: number
  /** Optional leading icon (kit icon, ~16px). */
  icon?: ReactNode
}

export interface ToastItem {
  id: number
  text: string
  icon?: ReactNode
  duration: number
}

type Listener = (toasts: readonly ToastItem[]) => void

const MAX_TOASTS = 2
let queue: readonly ToastItem[] = []
const listeners = new Set<Listener>()
let nextId = 1

function emit() {
  for (const fn of listeners) fn(queue)
}

/** Show a toast pill. Returns its id (usable with dismissToast). */
export function showToast(text: string, opts: ToastOptions = {}): number {
  const item: ToastItem = {
    id: nextId++,
    text,
    icon: opts.icon,
    duration: opts.duration ?? 2200,
  }
  queue = [...queue, item].slice(-MAX_TOASTS)
  emit()
  return item.id
}

/** Remove a toast early (auto-dismiss calls this for you). */
export function dismissToast(id: number): void {
  if (!queue.some((t) => t.id === id)) return
  queue = queue.filter((t) => t.id !== id)
  emit()
}

/** Current queue snapshot (stable reference between changes). */
export function getToasts(): readonly ToastItem[] {
  return queue
}

/** Subscribe to queue changes; fires immediately with the current queue. */
export function subscribeToasts(fn: Listener): () => void {
  listeners.add(fn)
  fn(queue)
  return () => {
    listeners.delete(fn)
  }
}
