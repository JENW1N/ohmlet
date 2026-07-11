/**
 * EmptyState — the friendly "Build your first circuit" glass card shown when
 * the layout has no components and no sheet is open (DESIGN.md §2). Two big
 * buttons route to the Parts sheet and the AI sheet.
 *
 * The card is a card-tier Liquid Glass lens (it floats directly over the
 * bright board — the showcase surface for the edge refraction) with the
 * tracked specular sheen, and a tone-adaptive platter: over the key-lit
 * empty board it flips to light glass with dark ink (glass/adapt.ts).
 */
import { useCallback, useEffect, useRef } from 'react'
import { attachToneAdapt, ChipIcon, PressableButton, SparklesIcon, useSpecular } from '../kit'

export interface EmptyStateProps {
  onBrowseParts: () => void
  onAskAi: () => void
}

export function EmptyState({ onBrowseParts, onAskAi }: EmptyStateProps) {
  const specRef = useSpecular<HTMLDivElement>()
  const cardRef = useRef<HTMLDivElement | null>(null)
  const setCard = useCallback(
    (node: HTMLDivElement | null) => {
      cardRef.current = node
      specRef(node)
    },
    [specRef],
  )
  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    return attachToneAdapt(el)
  }, [])
  return (
    <div className="app-empty" aria-label="Getting started">
      <div ref={setCard} className="lg-surface lg-lens lg-lens-card app-empty-card">
        <div className="lg-tone" aria-hidden="true" />
        <div className="app-empty-art" aria-hidden="true">
          <ChipIcon size={40} />
        </div>
        <div className="lg-title app-empty-title">Build your first circuit</div>
        <div className="lg-subhead app-empty-body">
          Place parts on the breadboard, wire them up, then tap the clock to run the simulation —
          or let AI build something for you.
        </div>
        <div className="app-empty-actions">
          <PressableButton variant="filled" size="lg" haptic icon={<ChipIcon size={20} />} onClick={onBrowseParts}>
            Browse parts
          </PressableButton>
          <PressableButton
            variant="tinted"
            size="lg"
            haptic
            // over-scene contrast: this card floats over the key-lit board
            className="lg-btn-over-scene"
            icon={<SparklesIcon size={20} />}
            onClick={onAskAi}
          >
            Ask AI
          </PressableButton>
        </div>
      </div>
    </div>
  )
}
