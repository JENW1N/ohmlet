/**
 * ApiKeyRow — the shared inline Anthropic API key editor, used by both the
 * AI sheet ("Add your API key" flow) and the More sheet (Settings group).
 *
 * Renders as a 44px list row showing the key status; tapping it expands an
 * inline editor: password field with Show/Hide, the privacy note, and
 * store.setApiKey on every keystroke (the store persists to localStorage).
 * Ported from the old SettingsDialog.
 *
 * Must be placed inside a `.lg-list` container (a kit <ListGroup>, or a
 * bare `<div className="lg-surface lg-list" role="list">`).
 */
import { useState } from 'react'
import { useStore } from '../../state/store'
import { ListRow, PressableButton } from '../kit'
import './asm-sheets.css'

/** Local key glyph (kit icons have no key; same 24-grid / 1.8 stroke style). */
function KeyGlyph({ size = 20 }: { size?: number }) {
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
      <circle cx="7.6" cy="12" r="3.4" />
      <path d="M11 12h9.4M16.6 12v3.1M20 12v2.3" />
    </svg>
  )
}

export interface ApiKeyRowProps {
  /** Row title — "Anthropic API key" (More) / "Add your API key" (AI). */
  title?: string
  /** Start with the inline editor expanded. */
  defaultOpen?: boolean
}

export function ApiKeyRow({ title = 'Anthropic API key', defaultOpen = false }: ApiKeyRowProps) {
  const apiKey = useStore((s) => s.llm.apiKey)
  const setApiKey = useStore((s) => s.setApiKey)
  const [editing, setEditing] = useState(defaultOpen)
  const [reveal, setReveal] = useState(false)
  const hasKey = apiKey.trim().length > 0

  return (
    <>
      <ListRow
        leading={<KeyGlyph />}
        title={title}
        trailing={<span className={hasKey ? 'asm-key-set' : undefined}>{hasKey ? 'Set' : 'Not set'}</span>}
        chevron
        onPress={() => setEditing((e) => !e)}
      />
      {editing && (
        <div className="asm-key-editor" role="listitem">
          <div className="asm-key-fieldrow">
            <input
              className="asm-input asm-mono"
              type={reveal ? 'text' : 'password'}
              value={apiKey}
              placeholder="sk-ant-…"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Anthropic API key"
              onChange={(e) => setApiKey(e.target.value)}
            />
            <PressableButton size="sm" variant="plain" onClick={() => setReveal((r) => !r)}>
              {reveal ? 'Hide' : 'Show'}
            </PressableButton>
          </div>
          <p className="asm-key-note lg-caption">
            Stored locally in this browser. Your key never leaves this browser except to{' '}
            <span className="asm-mono">api.anthropic.com</span>, which the AI Circuit Builder calls
            directly to generate circuits.
          </p>
        </div>
      )}
    </>
  )
}
