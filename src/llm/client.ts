/**
 * Anthropic client for the browser.
 *
 * The installed @anthropic-ai/sdk (0.104.x) supports browser usage natively
 * via `dangerouslyAllowBrowser: true` (it sets the
 * `anthropic-dangerous-direct-browser-access` header for us), so no raw-fetch
 * fallback is needed. The user's API key lives in localStorage and is sent
 * straight from their browser to api.anthropic.com — it never touches a
 * server of ours, which is the explicit design of this app.
 */

import Anthropic from '@anthropic-ai/sdk'

/** Model used for circuit generation. */
export const CLAUDE_MODEL = 'claude-opus-4-8'

export function createClient(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  })
}

/**
 * Map SDK errors to messages a non-expert user can act on.
 * Returns the original error untouched if it is not an API error
 * (e.g. our own validation Errors).
 */
export function friendlyApiError(err: unknown): Error {
  if (err instanceof Anthropic.APIUserAbortError) {
    return new Error('Generation cancelled.')
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error(
      'The Claude API rejected your API key (401). Check the key in the settings panel — it should start with "sk-ant-".',
    )
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new Error(
      'Your API key does not have permission for this model (403). Check your Anthropic Console plan and key scopes.',
    )
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new Error(
      `The model "${CLAUDE_MODEL}" was not found (404). Your account may not have access to it yet.`,
    )
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error('Rate limited by the Claude API (429). Wait a minute and try again.')
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new Error(`The Claude API rejected the request (400): ${err.message}`)
  }
  if (err instanceof Anthropic.InternalServerError) {
    return new Error(
      'The Claude API is having trouble right now (server error). Try again in a moment.',
    )
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new Error(
      'Could not reach the Claude API. Check your internet connection (or any ad-blocker/firewall blocking api.anthropic.com) and try again.',
    )
  }
  if (err instanceof Anthropic.APIError) {
    return new Error(`Claude API error${err.status ? ` (${err.status})` : ''}: ${err.message}`)
  }
  return err instanceof Error ? err : new Error(String(err))
}
