// SPDX-License-Identifier: GPL-2.0-or-later
// Disclosure modal shown the first time the user enables typing
// analytics recording. Lists what the recorder collects vs what it
// explicitly does not, then writes the AppConfig consent flag on
// accept so future enable clicks skip the modal. Storage / encryption
// / control instructions are intentionally not duplicated here — they
// live in the operation guide's Google App Data section.

import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { ModalCloseButton } from '../components/editors/ModalCloseButton'

interface Props {
  /** Called when the user clicks "Enable" — caller is expected to
   * persist the consent flag and start recording. */
  onAccept: () => void
  /** Called when the user dismisses the modal (Cancel button, Esc,
   * backdrop click). Recording stays off. */
  onCancel: () => void
}

export function TypingRecordingConsentModal({ onAccept, onCancel }: Props) {
  const { t } = useTranslation()
  const backdropRef = useRef<HTMLDivElement>(null)

  useEscapeClose(onCancel)

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onCancel()
  }, [onCancel])

  // i18next can return the key string when the bundle isn't loaded
  // (jsdom tests, missing locale). Fall back to an empty array in
  // that case so render doesn't blow up on `.map()`.
  const collectedRaw = t('editor.typingTest.consent.collectedItems', { returnObjects: true }) as unknown
  const notCollectedRaw = t('editor.typingTest.consent.notCollectedItems', { returnObjects: true }) as unknown
  const collected = Array.isArray(collectedRaw) ? collectedRaw as string[] : []
  const notCollected = Array.isArray(notCollectedRaw) ? notCollectedRaw as string[] : []

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-labelledby="typing-consent-title"
      onClick={handleBackdropClick}
      data-testid="typing-consent-modal"
    >
      <div className="flex w-[480px] flex-col rounded-xl border border-edge bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 id="typing-consent-title" className="text-lg font-semibold text-content">
            {t('editor.typingTest.consent.title')}
          </h2>
          <ModalCloseButton testid="typing-consent-close" onClick={onCancel} />
        </div>

        <div className="flex flex-col gap-4 px-5 py-4 text-[13px] text-content">
          <section>
            <h3 className="mb-2 text-sm font-semibold text-content">
              {t('editor.typingTest.consent.collectedHeading')}
            </h3>
            <ul className="ml-5 list-disc space-y-1 text-content-secondary">
              {collected.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
          <section>
            <h3 className="mb-2 text-sm font-semibold text-content">
              {t('editor.typingTest.consent.notCollectedHeading')}
            </h3>
            <ul className="ml-5 list-disc space-y-1 text-content-secondary">
              {notCollected.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        </div>

        <div className="flex justify-end gap-2 border-t border-edge px-4 py-3">
          <button
            type="button"
            data-testid="typing-consent-cancel"
            onClick={onCancel}
            className="rounded border border-edge px-3 py-1 text-sm text-content-secondary hover:bg-surface-dim"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            data-testid="typing-consent-accept"
            onClick={onAccept}
            className="rounded border border-accent bg-accent/10 px-3 py-1 text-sm text-accent hover:bg-accent/20"
          >
            {t('editor.typingTest.consent.accept')}
          </button>
        </div>
      </div>
    </div>
  )
}
