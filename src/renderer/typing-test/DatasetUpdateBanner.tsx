// SPDX-License-Identifier: GPL-2.0-or-later
//
// "An update is available" banner, shared by every dataset tab
// (MonkeyType / Tatoeba / Aozora). Pairs with useTypingDatasetUpdate;
// the caller owns the refresh-on-change side effects since those differ
// per provider (e.g. clearing the tatoeba pack cache).

import { useTranslation } from 'react-i18next'

interface Props {
  updateAvailable: boolean
  updating: boolean
  onUpdate: () => void
}

export function DatasetUpdateBanner({ updateAvailable, updating, onUpdate }: Props) {
  const { t } = useTranslation()
  if (!updateAvailable) return null

  return (
    <div
      className="flex items-center justify-between gap-3 border-b border-edge bg-accent/5 px-4 py-2"
      data-testid="typing-dataset-update-banner"
    >
      <span className="text-sm text-content-secondary">
        {t('editor.typingTest.language.datasetUpdateAvailable')}
      </span>
      <button
        type="button"
        data-testid="typing-dataset-update-button"
        disabled={updating}
        onClick={onUpdate}
        className="inline-flex h-8 items-center rounded-md border border-accent bg-accent/10 px-3 text-sm text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {t(updating ? 'editor.typingTest.language.datasetUpdating' : 'editor.typingTest.language.datasetUpdate')}
      </button>
    </div>
  )
}
