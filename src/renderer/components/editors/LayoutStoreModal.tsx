// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { ModalCloseButton } from './ModalCloseButton'
import { LayoutStoreContent } from './LayoutStoreContent'
import type { LayoutStoreContentProps } from './layout-store-types'

// Re-export for backward compatibility
export { LayoutStoreContent } from './LayoutStoreContent'
export type { FileStatus, HubEntryResult, LayoutStoreContentProps } from './layout-store-types'

interface Props extends LayoutStoreContentProps {
  onClose: () => void
}

export function LayoutStoreModal({ onClose, ...contentProps }: Props) {
  const { t } = useTranslation()
  useEscapeClose(onClose)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="layout-store-modal-backdrop"
      onClick={onClose}
    >
      <div
        className="w-[440px] max-w-[90vw] max-h-[85vh] flex flex-col rounded-2xl bg-surface-alt border border-edge shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-edge shrink-0">
          <h2 className="text-lg font-bold text-content">{t('layoutStore.title')}</h2>
          <ModalCloseButton testid="layout-store-modal-close" onClick={onClose} />
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 pb-5">
          <LayoutStoreContent {...contentProps} />
        </div>
      </div>
    </div>
  )
}
