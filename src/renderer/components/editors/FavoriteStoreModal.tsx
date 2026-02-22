// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { ModalCloseButton } from './ModalCloseButton'
import { FavoriteStoreContent, TYPE_LABEL_KEYS, type FavoriteStoreContentProps } from './FavoriteStoreContent'
import type { FavoriteType } from '../../../shared/types/favorite-store'

interface Props extends FavoriteStoreContentProps {
  favoriteType: FavoriteType
  onClose: () => void
}

export function FavoriteStoreModal({
  favoriteType,
  onClose,
  ...contentProps
}: Props) {
  const { t } = useTranslation()

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      data-testid="favorite-store-modal-backdrop"
      onClick={onClose}
    >
      <div
        className="w-[440px] max-w-[90vw] h-[70vh] flex flex-col rounded-2xl bg-surface-alt border border-edge shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-edge shrink-0">
          <h2 className="text-lg font-bold text-content">
            {t('favoriteStore.title')}
            <span className="ml-2 rounded bg-accent/20 px-2 py-0.5 text-xs text-accent">
              {t(TYPE_LABEL_KEYS[favoriteType])}
            </span>
          </h2>
          <ModalCloseButton testid="favorite-store-modal-close" onClick={onClose} />
        </div>

        <FavoriteStoreContent {...contentProps} />
      </div>
    </div>
  )
}
