// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutStoreContent, type LayoutStoreContentProps } from './LayoutStoreModal'
import { ModalCloseButton } from './ModalCloseButton'

const PANEL_BASE = 'absolute top-0 h-full w-[440px] max-w-[90vw] flex flex-col border-edge bg-surface-alt shadow-xl transition-transform duration-300 ease-out'

function panelPositionClass(open: boolean): string {
  return `${PANEL_BASE} left-0 border-r ${open ? 'translate-x-0' : '-translate-x-full'}`
}

interface Props extends Omit<LayoutStoreContentProps, 'keyboardName'> {
  onClose: () => void
  deviceName?: string
}

export function EditorSettingsModal({
  onClose,
  deviceName = '',
  isDummy,
  ...dataProps
}: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Trigger slide-in on next frame so the transition plays
    const id = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(id)
  }, [])

  return (
    <div
      className={`fixed inset-0 z-50 transition-colors duration-300 ${open ? 'bg-black/30' : 'bg-transparent'}`}
      data-testid="editor-settings-backdrop"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-settings-title"
        className={panelPositionClass(open)}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 shrink-0">
          <h2 id="editor-settings-title" className="text-lg font-bold text-content">{t('editorSettings.tabData')}</h2>
          <ModalCloseButton testid="editor-settings-close" onClick={onClose} />
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-5">
          <LayoutStoreContent
            {...dataProps}
            isDummy={isDummy}
            keyboardName={deviceName}
            listClassName="overflow-y-auto"
          />
        </div>
      </div>
    </div>
  )
}
