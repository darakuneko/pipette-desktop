// SPDX-License-Identifier: GPL-2.0-or-later
//
// Shared modal frame for the three pack-management modals: portal +
// backdrop, header (title + close), Installed/Find-on-Hub tabs, the
// Hub tab's search bar, the Installed tab's Import toolbar, the error
// banner, and the scrollable body. Every feature-specific bit (row
// rendering, per-op error copy, hub search fetch, etc.) stays in the
// calling modal and is threaded in via props/children.

import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { BTN_PRIMARY } from '../../constants/ui-tokens'
import { ModalCloseButton } from '../editors/ModalCloseButton'
import { PackTabButton } from './PackTabButton'
import type { PackManagerTabId } from './pack-modal-types'

export interface PackManagerModalTestIds {
  backdrop: string
  modal: string
  closeButton: string
  tabsContainer: string
  tabInstalled: string
  tabHub: string
  searchInput: string
  searchButton: string
  importButton: string
  /** Key Labels' error banner does not carry a testid; the other two do. */
  errorBanner?: string
}

export interface PackManagerModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  testids: PackManagerModalTestIds
  activeTab: PackManagerTabId
  onTabChange: (tab: PackManagerTabId) => void
  installedLabel: string
  hubLabel: string
  search: string
  onSearchChange: (value: string) => void
  /** Fired on Enter inside the search box — each feature decides
   * whether to trim the query first (i18n/theme don't, Key Labels does). */
  onSearchEnter: () => void
  onSearchClick: () => void
  searchPlaceholder: string
  searchButtonLabel: ReactNode
  searchDisabled: boolean
  importLabel: string
  onImport: () => void
  /** "Name" sort toggle rendered at the left end of the Installed
   *  toolbar, opposite Import. Required — all three modals have one. */
  sortButton: ReactNode
  actionError: string | null
  children: ReactNode
  /** Language Packs renders MissingKeysModal as a portal sibling after
   * the modal box; unused by Theme Packs / Key Labels. */
  afterContent?: ReactNode
}

export function PackManagerModal({
  open,
  onClose,
  title,
  testids,
  activeTab,
  onTabChange,
  installedLabel,
  hubLabel,
  search,
  onSearchChange,
  onSearchEnter,
  onSearchClick,
  searchPlaceholder,
  searchButtonLabel,
  searchDisabled,
  importLabel,
  onImport,
  sortButton,
  actionError,
  children,
  afterContent,
}: PackManagerModalProps): JSX.Element | null {
  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid={testids.backdrop}
      onClick={onClose}
    >
      <div
        className="w-modal-lg max-w-modal-vw h-modal-80vh flex flex-col rounded-lg bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
        data-testid={testids.modal}
      >
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 className="text-base font-semibold text-content">{title}</h2>
          <ModalCloseButton testid={testids.closeButton} onClick={onClose} />
        </div>

        <div className="flex border-b border-edge" data-testid={testids.tabsContainer}>
          <PackTabButton
            label={installedLabel}
            active={activeTab === 'installed'}
            onClick={() => onTabChange('installed')}
            testid={testids.tabInstalled}
          />
          <PackTabButton
            label={hubLabel}
            active={activeTab === 'hub'}
            onClick={() => onTabChange('hub')}
            testid={testids.tabHub}
          />
        </div>

        {activeTab === 'hub' && (
          <div className="flex items-center gap-2 px-4 py-3 border-b border-edge">
            <input
              type="text"
              value={search}
              placeholder={searchPlaceholder}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onSearchEnter() }}
              className="flex-1 rounded border border-edge bg-surface px-3 py-1.5 text-sm text-content focus:border-accent focus:outline-none"
              data-testid={testids.searchInput}
            />
            <button
              type="button"
              disabled={searchDisabled}
              onClick={onSearchClick}
              className={BTN_PRIMARY}
              data-testid={testids.searchButton}
            >
              {searchButtonLabel}
            </button>
          </div>
        )}

        {activeTab === 'installed' && (
          <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
            {sortButton}
            <button
              type="button"
              onClick={onImport}
              className="rounded border border-edge bg-surface px-3 py-1.5 text-sm font-medium text-content hover:bg-surface-hover"
              data-testid={testids.importButton}
            >
              {importLabel}
            </button>
          </div>
        )}

        {actionError && (
          <div
            className="mx-4 my-2 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-700"
            data-testid={testids.errorBanner}
          >
            {actionError}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-2">
          {children}
        </div>
      </div>
      {afterContent}
    </div>,
    document.body,
  )
}
