// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import type { DataNavPath } from './data-modal-types'
import type { StoredKeyboardInfo, SyncDataScanResult } from '../../../shared/types/sync'
import type { FavoriteType } from '../../../shared/types/favorite-store'

interface Props {
  storedKeyboards: StoredKeyboardInfo[]
  activePath: DataNavPath | null
  onNavigate: (path: DataNavPath) => void
  isExpanded: (nodeId: string) => boolean
  onToggle: (nodeId: string) => void
  showHubTab: boolean
  syncScanResult: SyncDataScanResult | null
  syncScanning: boolean
}

const FAVORITE_TYPES: { type: FavoriteType; labelKey: string }[] = [
  { type: 'tapDance', labelKey: 'editor.tapDance.title' },
  { type: 'macro', labelKey: 'editor.macro.title' },
  { type: 'combo', labelKey: 'editor.combo.title' },
  { type: 'keyOverride', labelKey: 'editor.keyOverride.title' },
  { type: 'altRepeatKey', labelKey: 'editor.altRepeatKey.title' },
]

function isActivePath(a: DataNavPath | null, b: DataNavPath): boolean {
  if (!a) return false
  if (a.section !== b.section || a.page !== b.page) return false
  if (a.page === 'keyboard' && b.page === 'keyboard') return a.uid === b.uid
  if (a.page === 'favorite' && b.page === 'favorite') return a.favoriteType === b.favoriteType
  if (a.page === 'sync-keyboard' && b.page === 'sync-keyboard') return a.uid === b.uid
  if (a.page === 'sync-favorite' && b.page === 'sync-favorite') return a.favoriteType === b.favoriteType
  return true
}

const LEAF_BASE = 'w-full text-left text-[13px] py-1 rounded cursor-pointer truncate'
const LEAF_ACTIVE = `${LEAF_BASE} bg-surface-dim text-content font-medium`
const LEAF_IDLE = `${LEAF_BASE} text-content-secondary hover:text-content hover:bg-surface-dim/50`

const BRANCH_BASE = 'w-full text-left text-[13px] py-1 flex items-center gap-1 cursor-pointer truncate'

function Chevron({ open }: { open: boolean }) {
  return (
    <span
      className={`inline-block text-[9px] text-content-muted transition-transform ${open ? 'rotate-90' : ''}`}
      aria-hidden="true"
    >
      &#9654;
    </span>
  )
}

interface LeafProps {
  label: string
  depth: number
  active: boolean
  onClick: () => void
  testId?: string
}

function Leaf({ label, depth, active, onClick, testId }: LeafProps) {
  return (
    <button
      type="button"
      className={active ? LEAF_ACTIVE : LEAF_IDLE}
      style={{ paddingLeft: `${depth * 14 + 8}px` }}
      onClick={onClick}
      data-testid={testId}
    >
      {label}
    </button>
  )
}

interface BranchProps {
  label: string
  depth: number
  open: boolean
  onToggle: () => void
  testId?: string
  children: React.ReactNode
}

function Branch({ label, depth, open, onToggle, testId, children }: BranchProps) {
  return (
    <>
      <button
        type="button"
        className={`${BRANCH_BASE} text-content-secondary hover:text-content`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={onToggle}
        data-testid={testId}
      >
        <Chevron open={open} />
        <span className="truncate">{label}</span>
      </button>
      {open && children}
    </>
  )
}

export function DataNavTree({ storedKeyboards, activePath, onNavigate, isExpanded, onToggle, showHubTab, syncScanResult, syncScanning }: Props) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-0.5 py-2 px-1" data-testid="data-nav-tree">
      {/* ── Local ── */}
      <Branch
        label={t('dataModal.local')}
        depth={0}
        open={isExpanded('local')}
        onToggle={() => onToggle('local')}
        testId="nav-local"
      >
        {/* Keyboards */}
        <Branch
          label={t('dataModal.keyboards')}
          depth={1}
          open={isExpanded('local-keyboards')}
          onToggle={() => onToggle('local-keyboards')}
          testId="nav-local-keyboards"
        >
          {storedKeyboards.length === 0 ? (
            <div
              className="text-[11px] text-content-muted py-1"
              style={{ paddingLeft: '50px' }}
              data-testid="nav-no-keyboards"
            >
              {t('dataModal.noKeyboards')}
            </div>
          ) : (
            storedKeyboards.map((kb) => (
              <Leaf
                key={kb.uid}
                label={kb.name}
                depth={2}
                active={isActivePath(activePath, { section: 'local', page: 'keyboard', uid: kb.uid, name: kb.name })}
                onClick={() => onNavigate({ section: 'local', page: 'keyboard', uid: kb.uid, name: kb.name })}
                testId={`nav-kb-${kb.uid}`}
              />
            ))
          )}
        </Branch>

        {/* Favorites */}
        <Branch
          label={t('dataModal.favorites')}
          depth={1}
          open={isExpanded('local-favorites')}
          onToggle={() => onToggle('local-favorites')}
          testId="nav-local-favorites"
        >
          {FAVORITE_TYPES.map(({ type, labelKey }) => (
            <Leaf
              key={type}
              label={t(labelKey)}
              depth={2}
              active={isActivePath(activePath, { section: 'local', page: 'favorite', favoriteType: type })}
              onClick={() => onNavigate({ section: 'local', page: 'favorite', favoriteType: type })}
              testId={`nav-fav-${type}`}
            />
          ))}
        </Branch>

        {/* Application */}
        <Leaf
          label={t('dataModal.application')}
          depth={1}
          active={isActivePath(activePath, { section: 'local', page: 'application' })}
          onClick={() => onNavigate({ section: 'local', page: 'application' })}
          testId="nav-local-application"
        />
      </Branch>

      {/* ── Sync ── */}
      <Branch
        label={t('dataModal.sync')}
        depth={0}
        open={isExpanded('sync')}
        onToggle={() => onToggle('sync')}
        testId="nav-sync"
      >
        {syncScanning ? (
          <div className="text-[11px] text-content-muted py-1" style={{ paddingLeft: '36px' }}>
            {t('sync.scanning')}
          </div>
        ) : !syncScanResult ? (
          <div className="text-[11px] text-content-muted py-1" style={{ paddingLeft: '36px' }}>
            {t('sync.noRemoteData')}
          </div>
        ) : (
          <>
            {/* Sync Keyboards */}
            {syncScanResult.keyboards.length > 0 && (
              <Branch
                label={t('dataModal.keyboards')}
                depth={1}
                open={isExpanded('sync-keyboards')}
                onToggle={() => onToggle('sync-keyboards')}
                testId="nav-sync-keyboards"
              >
                {syncScanResult.keyboards.map((uid) => (
                  <Leaf
                    key={uid}
                    label={storedKeyboards.find((kb) => kb.uid === uid)?.name ?? uid}
                    depth={2}
                    active={isActivePath(activePath, { section: 'sync', page: 'sync-keyboard', uid, name: '' })}
                    onClick={() => onNavigate({ section: 'sync', page: 'sync-keyboard', uid, name: storedKeyboards.find((kb) => kb.uid === uid)?.name ?? uid })}
                    testId={`nav-sync-kb-${uid}`}
                  />
                ))}
              </Branch>
            )}

          </>
        )}
      </Branch>

      {/* ── Hub ── */}
      {showHubTab && (
        <Leaf
          label={t('dataModal.hub')}
          depth={0}
          active={isActivePath(activePath, { section: 'cloud', page: 'hub' })}
          onClick={() => onNavigate({ section: 'cloud', page: 'hub' })}
          testId="nav-cloud-hub"
        />
      )}
    </div>
  )
}
