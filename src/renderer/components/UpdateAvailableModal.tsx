// SPDX-License-Identifier: GPL-2.0-or-later
// The update modal: a new version with its release page, Update (the
// download's progress, then the app restarts), Not now and Skip this
// version; or the failure the last update left. Same frame as
// NotificationModal.

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../hooks/useEscapeClose'
import type { UpdateCheckState, UpdatePrompt } from '../hooks/useUpdateCheck'
import type { UpdateErrorCode, UpdateProgress } from '../../shared/types/update'
import { BTN_PRIMARY, BTN_SECONDARY } from '../constants/ui-tokens'
import { ModalCloseButton } from './editors/ModalCloseButton'

interface Props {
  prompt: UpdatePrompt
  onClose: () => void
  /** "Skip this version"; the button is shown only with it. */
  onSkip?: () => void
}

type Phase = 'idle' | 'installing' | 'restarting' | 'failed'

const BYTES_PER_MB = 1024 * 1024

function megabytes(bytes: number): string {
  return (bytes / BYTES_PER_MB).toFixed(1)
}

export function UpdateAvailableModal({ prompt, onClose, onSkip }: Props) {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<Phase>(prompt.kind === 'failed' ? 'failed' : 'idle')
  const [code, setCode] = useState<UpdateErrorCode | null>(prompt.kind === 'failed' ? prompt.code : null)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const busy = phase === 'installing' || phase === 'restarting'
  const close = useCallback(() => {
    if (!busy) onClose()
  }, [busy, onClose])
  useEscapeClose(close, !busy)

  useEffect(() => {
    if (phase !== 'installing') return
    return window.vialAPI.updateOnProgress(setProgress)
  }, [phase])

  const install = useCallback(async () => {
    setPhase('installing')
    setProgress(null)
    setCode(null)
    const result = await window.vialAPI.updateInstall(prompt.version).catch(() => null)
    if (result?.status === 'restarting') {
      setPhase('restarting')
    } else {
      setPhase('failed')
      setCode(result?.code ?? 'unknown')
    }
  }, [prompt.version])

  const openReleasePage = useCallback(() => {
    void window.vialAPI.openExternal(prompt.releaseUrl).catch(() => {})
  }, [prompt.releaseUrl])

  const percent = progress?.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="update-modal-backdrop"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-modal-title"
        className="w-modal-notify max-w-modal-vw max-h-modal-80vh overflow-y-auto rounded-lg bg-surface-alt p-6 shadow-xl"
        data-testid="update-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 id="update-modal-title" className="text-lg font-semibold">
            {prompt.kind === 'failed' ? t('update.failedTitle') : t('update.title')}
          </h3>
          {!busy && <ModalCloseButton testid="update-modal-close" onClick={close} />}
        </div>

        <div className="space-y-3 text-sm">
          {prompt.kind === 'available' && (
            <p data-testid="update-modal-message">
              {t('update.message', { version: prompt.version, currentVersion: prompt.currentVersion })}
            </p>
          )}
          <button
            type="button"
            className="text-accent underline hover:text-accent/80"
            data-testid="update-modal-release-link"
            onClick={openReleasePage}
          >
            {t('update.releasePage', { version: prompt.version })}
          </button>

          {phase === 'installing' && (
            <div data-testid="update-modal-progress">
              <p className="mb-2 text-content-secondary">
                {percent !== null
                  ? t('update.downloadingPercent', { percent })
                  : t('update.downloading', { size: megabytes(progress?.downloaded ?? 0) })}
              </p>
              <div className="h-2 overflow-hidden rounded bg-surface-dim">
                <div className="h-full bg-accent transition-all" style={{ width: `${percent ?? 0}%` }} />
              </div>
            </div>
          )}
          {phase === 'restarting' && (
            <p className="text-content-secondary" data-testid="update-modal-restarting">
              {t('update.restarting')}
            </p>
          )}
          {phase === 'failed' && code && (
            <div role="alert" className="space-y-1" data-testid="update-modal-error">
              <p className="text-danger">
                {t(`update.error.${code}`, { path: prompt.kind === 'failed' ? prompt.backupPath : undefined })}
              </p>
              <p className="text-content-secondary">{t('update.errorHint')}</p>
            </div>
          )}
        </div>

        {prompt.kind === 'available' && !busy && (
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            {onSkip && (
              <button type="button" className={BTN_SECONDARY} data-testid="update-modal-skip" onClick={onSkip}>
                {t('update.skip')}
              </button>
            )}
            <button type="button" className={BTN_SECONDARY} data-testid="update-modal-later" onClick={close}>
              {t('update.later')}
            </button>
            <button type="button" className={BTN_PRIMARY} data-testid="update-modal-install" onClick={() => void install()}>
              {phase === 'failed' ? t('update.retry') : t('update.install')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** The modal of the startup check (useUpdateCheck), when it has a prompt. */
export function StartupUpdateModal({ updateCheck }: { updateCheck: UpdateCheckState }) {
  const { prompt, close, skip } = updateCheck
  if (!prompt) return null
  return (
    <UpdateAvailableModal
      key={`${prompt.kind}-${prompt.version}`}
      prompt={prompt}
      onClose={close}
      onSkip={prompt.kind === 'available' ? skip : undefined}
    />
  )
}
