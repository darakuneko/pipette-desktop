// SPDX-License-Identifier: GPL-2.0-or-later
// The About tab's "Check for updates": checks on demand and shows what it
// found, a version the user skipped included, with the update modal for an
// available version.

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BTN_SECONDARY } from '../constants/ui-tokens'
import type { UpdateCheckResult } from '../../shared/types/update'
import type { UpdatePrompt } from '../hooks/useUpdateCheck'
import { UpdateAvailableModal } from './UpdateAvailableModal'

type CheckState = { status: 'idle' } | { status: 'checking' } | UpdateCheckResult

export function AboutUpdateCheck() {
  const { t } = useTranslation()
  const [state, setState] = useState<CheckState>({ status: 'idle' })
  const [prompt, setPrompt] = useState<UpdatePrompt | null>(null)

  const check = useCallback(async () => {
    setState({ status: 'checking' })
    const result = await window.vialAPI.updateCheck().catch((): UpdateCheckResult => ({ status: 'failed', code: 'unknown' }))
    setState(result)
  }, [])

  return (
    <div className="flex flex-col items-center gap-2" data-testid="about-update">
      <button
        type="button"
        className={BTN_SECONDARY}
        disabled={state.status === 'checking'}
        data-testid="about-update-check"
        onClick={() => void check()}
      >
        {t('update.about.check')}
      </button>
      {state.status !== 'idle' && (
        <p className="text-center text-sm text-content-muted" role="status" data-testid="about-update-result">
          {state.status === 'checking' && t('update.about.checking')}
          {state.status === 'disabled' && t('update.about.disabled')}
          {state.status === 'upToDate' && t('update.about.upToDate')}
          {state.status === 'failed' && t(`update.error.${state.code}`)}
          {state.status === 'available' &&
            (state.skipped
              ? t('update.about.availableSkipped', { version: state.version })
              : t('update.about.available', { version: state.version }))}
        </p>
      )}
      {state.status === 'available' && (
        <button
          type="button"
          className="text-sm text-accent underline hover:text-accent/80"
          data-testid="about-update-open"
          onClick={() =>
            setPrompt({
              kind: 'available',
              version: state.version,
              currentVersion: state.currentVersion,
              releaseUrl: state.releaseUrl,
            })
          }
        >
          {t('update.about.open', { version: state.version })}
        </button>
      )}
      {prompt && <UpdateAvailableModal key={prompt.version} prompt={prompt} onClose={() => setPrompt(null)} />}
    </div>
  )
}
