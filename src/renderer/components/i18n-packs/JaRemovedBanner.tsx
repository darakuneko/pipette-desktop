// SPDX-License-Identifier: GPL-2.0-or-later
//
// One-shot notice surfaced after the bundled Japanese language was
// extracted into the language pack store. Triggered when the
// AppConfig migration in main/app-config.ts maps a legacy
// `language: 'ja'` to `'builtin:en'` and stamps `oneShotNotice =
// 'ja-removed'`. Dismissing the banner clears the flag so the user
// only sees it once per device.

import { useTranslation } from 'react-i18next'
import { useAppConfig } from '../../hooks/useAppConfig'

export function JaRemovedBanner(): JSX.Element | null {
  const { t } = useTranslation()
  const appConfig = useAppConfig()

  if (appConfig.config.oneShotNotice !== 'ja-removed') return null

  const dismiss = (): void => {
    appConfig.set('oneShotNotice', null)
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      data-testid="ja-removed-banner"
      role="dialog"
      aria-modal="true"
    >
      <div className="max-w-md rounded-lg border border-edge bg-surface p-4 shadow-lg">
        <h2 className="mb-2 text-lg font-semibold text-content">
          {t('i18n.jaRemoved.title')}
        </h2>
        <p className="mb-4 text-sm text-content-secondary">
          {t('i18n.jaRemoved.message')}
        </p>
        <div className="flex justify-end">
          <button
            type="button"
            className="rounded bg-accent px-3 py-1 text-sm font-medium text-white hover:bg-accent/90"
            onClick={dismiss}
            data-testid="ja-removed-dismiss"
          >
            {t('i18n.jaRemoved.dismiss')}
          </button>
        </div>
      </div>
    </div>
  )
}
