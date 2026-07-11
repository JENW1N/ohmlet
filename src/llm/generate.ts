/**
 * Generate → validate → verify → repair pipeline.
 *
 * Streams a structured-output response from Claude (claude-opus-4-8, adaptive
 * thinking), converts the wire format to a CircuitLayout, runs validateLayout,
 * then machine-tests the layout in the simulator against the model's declared
 * expectations (runVerification). Validation errors and verification failures
 * are both sent back verbatim as repair turns, sharing one combined repair
 * budget, before giving up with a descriptive Error.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { BoardConfig, BoardSizeId, CircuitLayout } from '../model/types'
import { asBoardConfig } from '../model/types'
import { validateLayout } from '../model/validate'
import { CLAUDE_MODEL, createClient, friendlyApiError } from './client'
import { buildSystemPrompt } from './prompt'
import { CIRCUIT_OUTPUT_SCHEMA, emitToExpectations, emitToLayout, extractEnvelope } from './schema'
import type { Expectation } from './schema'
import { describeExpectation, runVerification } from './verify'
import type { VerifyResult } from './verify'

/** Max repair rounds (validation + verification combined) after the initial attempt. */
const MAX_REPAIRS = 3
const MAX_OUTPUT_TOKENS = 32000

export interface GenerateCircuitOptions {
  apiKey: string
  prompt: string
  /**
   * Active board rig — threaded into the system prompt and the wire-format
   * converters (default 'standard' × 1 × 1 row). Accepts a bare size id
   * (= one board, back-compat) or a full BoardConfig (whose optional `rows`
   * carries the 2-D grid depth). The model may still emit a LARGER "board" /
   * "boardCount" / "boardRows" in its output when the request needs more
   * room.
   */
  boardConfig?: BoardConfig | BoardSizeId
  onStatus?: (status: string) => void
  signal?: AbortSignal
}

export interface GenerateCircuitResult {
  layout: CircuitLayout
  explanation: string
  /** the layout was built in the simulator and passed every declared expectation */
  verified: true
  /** human-readable list of the expectations that passed */
  expectationSummary: string[]
}

interface AttemptOutcome {
  layout?: CircuitLayout
  expectations: Expectation[]
  explanation: string
  errors: string[]
}

// ---------------------------------------------------------------------------
// "Tested in simulation" badge plumbing: the UI (AiSheet) holds only the
// pending CircuitLayout object, so we remember the summary for the exact
// layout object the last successful generation returned.
// ---------------------------------------------------------------------------

let lastVerifiedLayout: CircuitLayout | null = null
let lastVerifiedSummary: string[] = []

function rememberVerified(layout: CircuitLayout, summary: string[]): void {
  lastVerifiedLayout = layout
  lastVerifiedSummary = summary
}

/**
 * Passed-expectation summary for a layout returned by generateCircuit (same
 * object identity, e.g. the store's llm.pending); null when the layout is not
 * the most recent verified result.
 */
export function verifiedSummaryFor(layout: CircuitLayout | null | undefined): string[] | null {
  return layout && layout === lastVerifiedLayout ? lastVerifiedSummary : null
}

function buildRepairMessage(errors: string[]): string {
  return [
    'The circuit you produced failed validation with the following errors:',
    ...errors.map((e) => `- ${e}`),
    '',
    'Fix every error and return the complete corrected circuit (all components and all wires, not just the changed parts) plus its expectations in the same JSON format.',
  ].join('\n')
}

function buildVerificationRepairMessage(failures: string[]): string {
  return [
    'The circuit you produced passed validation, but it was then built in the simulator and machine-tested against your declared expectations, and it FAILED:',
    ...failures.map((e) => `- ${e}`),
    '',
    'Use the measured data above to find the wiring or component-value mistake. Return the complete corrected circuit (all components and all wires, not just the changed parts) AND corrected expectations in the same JSON format. Only declare expectations the corrected circuit will honestly meet.',
  ].join('\n')
}

function interpretMessage(message: Anthropic.Message, activeBoard: BoardConfig): AttemptOutcome {
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')

  if (message.stop_reason === 'refusal') {
    throw new Error('Claude declined to design this circuit. Try rephrasing the request.')
  }
  if (message.stop_reason === 'max_tokens') {
    return {
      explanation: '',
      expectations: [],
      errors: [
        'your response was cut off at the output-token limit before the JSON was complete — produce a smaller, more compact circuit',
      ],
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return {
      explanation: '',
      expectations: [],
      errors: [
        `the response was not valid JSON (${err instanceof Error ? err.message : String(err)}) — respond with exactly one JSON object matching the schema`,
      ],
    }
  }

  let explanation = ''
  let expectations: Expectation[] = []
  let candidate: CircuitLayout
  try {
    const envelope = extractEnvelope(parsed)
    explanation = envelope.explanation
    expectations = emitToExpectations(envelope.expectations)
    // "board"/"boardCount"/"boardRows": null means "the active rig" (schema
    // contract) — resolve it here so validation uses the right bounds and
    // applying the result never silently switches the user's board preset,
    // module count or board-row depth.
    candidate = emitToLayout(envelope.circuit, activeBoard)
  } catch (err) {
    return {
      explanation: '',
      expectations: [],
      errors: [err instanceof Error ? err.message : String(err)],
    }
  }

  const result = validateLayout(candidate)
  if (result.ok && result.layout) {
    return { layout: result.layout, expectations, explanation, errors: [] }
  }
  return { explanation, expectations, errors: result.errors }
}

/**
 * Generate a circuit layout from a natural-language description.
 * Throws a user-friendly Error on API failures, cancellation, or when the
 * model cannot produce a valid layout after the repair rounds.
 */
export async function generateCircuit(
  opts: GenerateCircuitOptions,
): Promise<GenerateCircuitResult> {
  const { apiKey, prompt, boardConfig = 'standard', onStatus, signal } = opts
  const activeConfig = asBoardConfig(boardConfig)
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('No API key set — add your Anthropic API key first.')
  }
  if (!prompt || prompt.trim().length === 0) {
    throw new Error('Describe the circuit you want first.')
  }

  const client = createClient(apiKey)

  // Deterministic system prompt with a cache breakpoint: the (large) catalog +
  // rules prefix is identical across calls for a given (catalog, board rig),
  // so repeat generations and repair rounds read it from the prompt cache.
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: buildSystemPrompt(activeConfig), cache_control: { type: 'ephemeral' } },
  ]
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt.trim() }]

  let lastErrors: string[] = []

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    if (signal?.aborted) throw new Error('Generation cancelled.')
    onStatus?.(attempt === 0 ? 'thinking…' : `repairing (attempt ${attempt})…`)

    let message: Anthropic.Message
    try {
      const stream = client.messages.stream(
        {
          model: CLAUDE_MODEL,
          max_tokens: MAX_OUTPUT_TOKENS,
          thinking: { type: 'adaptive' },
          system,
          messages,
          output_config: {
            format: { type: 'json_schema', schema: CIRCUIT_OUTPUT_SCHEMA },
          },
        },
        { signal },
      )
      let designing = false
      stream.on('text', () => {
        if (!designing) {
          designing = true
          onStatus?.('designing circuit…')
        }
      })
      message = await stream.finalMessage()
    } catch (err) {
      throw friendlyApiError(err)
    }

    onStatus?.('validating…')
    const outcome = interpretMessage(message, activeConfig)
    let repairMessage: string

    if (outcome.layout) {
      // Validation passed — machine-test the circuit in the simulator
      // (worker-backed; an abort terminates the in-flight verification).
      onStatus?.('testing circuit in the simulator…')
      let verdict: VerifyResult
      try {
        verdict = await runVerification(outcome.layout, outcome.expectations, { signal })
      } catch (err) {
        if (signal?.aborted) throw new Error('Generation cancelled.')
        throw err instanceof Error ? err : new Error(String(err))
      }
      if (verdict.pass) {
        const expectationSummary = outcome.expectations.map(describeExpectation)
        rememberVerified(outcome.layout, expectationSummary)
        return {
          layout: outcome.layout,
          explanation: outcome.explanation,
          verified: true,
          expectationSummary,
        }
      }
      lastErrors = [...verdict.failures, ...verdict.health]
      repairMessage = buildVerificationRepairMessage(lastErrors)
    } else {
      lastErrors = outcome.errors
      repairMessage = buildRepairMessage(lastErrors)
    }

    // Append the assistant turn (content blocks unchanged, including thinking
    // blocks — required for same-model continuation) plus the verbatim
    // validation/verification failures, then go around again.
    messages.push({
      role: 'assistant',
      content: message.content as Anthropic.ContentBlockParam[],
    })
    messages.push({ role: 'user', content: repairMessage })
  }

  throw new Error(
    `Claude could not produce a working circuit after ${MAX_REPAIRS + 1} attempts. ` +
      `Last failures:\n${lastErrors.map((e) => `- ${e}`).join('\n')}`,
  )
}
