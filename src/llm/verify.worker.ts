/**
 * Module Worker entry: runs verifyCircuit off the main thread so the UI
 * never jank-freezes while the simulator machine-tests a generated circuit.
 * Spawned by runVerification() in ./verify.ts via
 *   new Worker(new URL('./verify.worker.ts', import.meta.url), { type: 'module' })
 * Protocol: one VerifyRequest in → one structured-clone-safe VerifyReply out.
 */

import { verifyCircuit } from './verify'
import type { VerifyReply, VerifyRequest } from './verify'

// tsconfig uses the DOM lib (no WebWorker lib): type the worker global scope
// through the structural Worker interface, which has the right onmessage /
// single-argument postMessage shapes.
const ctx = self as unknown as Worker

ctx.onmessage = (e: MessageEvent<VerifyRequest>) => {
  let reply: VerifyReply
  try {
    const { layout, expectations } = e.data
    reply = { ok: true, result: verifyCircuit(layout, expectations) }
  } catch (err) {
    reply = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  ctx.postMessage(reply)
}
