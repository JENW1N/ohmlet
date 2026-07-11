/**
 * Onboarding — first-launch 3-step coach overlay (DESIGN.md §2): rotate/zoom
 * gestures → parts → AI. Springy (transform/opacity only, house spring via
 * the --lg-dur/--lg-spring tokens, which collapse under reduced motion),
 * skippable, 3 dots. The caller persists the 'bb.onboarded' flag in onDone.
 */
import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChipIcon, PressableButton, ResetIcon, SparklesIcon, pressProps, tick } from '../kit'

export const ONBOARDED_KEY = 'bb.onboarded'

/** True when this browser has not completed/skipped onboarding yet. */
export function needsOnboarding(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDED_KEY) == null
  } catch {
    return false
  }
}

/** Persist the flag (callers also flip their own React state). */
export function markOnboarded(): void {
  try {
    window.localStorage.setItem(ONBOARDED_KEY, '1')
  } catch {
    /* private mode — show it again next launch, no harm */
  }
}

interface Step {
  icon: ReactNode
  title: string
  body: string
}

const STEPS: readonly Step[] = [
  {
    icon: <ResetIcon size={40} />,
    title: 'Look around',
    body: 'Drag to orbit the board, pinch to zoom, two fingers to pan. Double-tap empty space to re-frame.',
  },
  {
    icon: <ChipIcon size={40} />,
    title: 'Place parts',
    body: 'Open Parts in the dock, pick a component, then tap board holes to place it. Wire mode connects them.',
  },
  {
    icon: <SparklesIcon size={40} />,
    title: 'Or just ask',
    body: 'Describe any circuit in the AI tab — it appears on the board, ready to run.',
  },
]

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)
  const last = step === STEPS.length - 1

  const next = () => {
    tick()
    if (last) onDone()
    else setStep((s) => Math.min(s + 1, STEPS.length - 1))
  }

  if (typeof document === 'undefined') return null

  // Portaled to <body>: the dock/capsule/toasts live there now (they must
  // z-stack above sheets), and the coach overlay must cover ALL of them.
  return createPortal(
    <div className="app-onboard" role="dialog" aria-modal="true" aria-label="Welcome tour">
      <div className="app-onboard-scrim" />
      <div className="lg-surface app-onboard-card">
        <div className="app-onboard-track-clip">
          <div
            className="app-onboard-track"
            style={{ transform: `translate3d(${-step * (100 / STEPS.length)}%, 0, 0)` }}
          >
            {STEPS.map((s, i) => (
              <div className="app-onboard-step" key={i} aria-hidden={i !== step}>
                <div className="app-onboard-icon">{s.icon}</div>
                <div className="lg-title">{s.title}</div>
                <div className="lg-subhead app-onboard-body">{s.body}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="app-onboard-dots" aria-hidden="true">
          {STEPS.map((_, i) => (
            <button
              key={i}
              type="button"
              tabIndex={-1}
              className={`app-onboard-dot lg-hit ${i === step ? 'is-active' : ''}`}
              onClick={() => setStep(i)}
            />
          ))}
        </div>

        <div className="app-onboard-actions">
          <button type="button" className="app-onboard-skip lg-pressable" {...pressProps} onClick={onDone}>
            Skip
          </button>
          <PressableButton variant="filled" size="md" onClick={next}>
            {last ? 'Get started' : 'Next'}
          </PressableButton>
        </div>
      </div>
    </div>,
    document.body,
  )
}
