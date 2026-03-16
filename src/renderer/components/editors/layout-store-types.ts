// SPDX-License-Identifier: GPL-2.0-or-later

import type { SnapshotMeta } from '../../../shared/types/snapshot-store'
import type { HubMyPost } from '../../../shared/types/hub'

export type FileStatus =
  | 'idle'
  | 'importing'
  | 'exporting'
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string }

export interface HubEntryResult {
  kind: 'success' | 'error'
  message: string
  entryId: string
  /** Additional entry IDs sharing the same result (e.g. batch migration) */
  entryIds?: string[]
}

export interface LayoutStoreContentProps {
  entries: SnapshotMeta[]
  loading?: boolean
  saving?: boolean
  fileStatus?: FileStatus
  isDummy?: boolean
  defaultSaveLabel?: string
  onSave: (label: string) => void
  onLoad: (entryId: string) => void
  onRename: (entryId: string, newLabel: string) => void
  onDelete: (entryId: string) => void
  onImportVil?: () => void
  onExportVil?: () => Promise<boolean>
  onExportKeymapC?: () => Promise<boolean>
  onExportPdf?: () => Promise<boolean>
  onSideloadJson?: () => void
  onExportEntryVil?: (entryId: string) => void
  onExportEntryKeymapC?: (entryId: string) => void
  onExportEntryPdf?: (entryId: string) => void
  onOverwriteSave?: (overwriteEntryId: string, label: string) => void
  onUploadToHub?: (entryId: string) => void
  onUpdateOnHub?: (entryId: string) => void
  onRemoveFromHub?: (entryId: string) => void
  onReuploadToHub?: (entryId: string, orphanedPostId: string) => void
  onDeleteOrphanedHubPost?: (entryId: string, orphanedPostId: string) => void
  keyboardName: string
  hubOrigin?: string
  hubMyPosts?: HubMyPost[]
  hubKeyboardPosts?: HubMyPost[]
  hubNeedsDisplayName?: boolean
  hubUploading?: string | null
  hubUploadResult?: HubEntryResult | null
  fileDisabled?: boolean
  listClassName?: string
  footer?: React.ReactNode
}

export const FORMAT_BTN = 'text-[11px] font-medium text-content-muted bg-surface/50 border border-edge px-2 py-0.5 rounded hover:text-content hover:border-content-muted disabled:opacity-50'
export const IMPORT_BTN = 'rounded-lg border border-edge bg-surface/30 px-3 py-1.5 text-xs font-semibold text-content-muted hover:text-content hover:border-content-muted'
export const EXPORT_BTN = 'rounded-lg border border-edge bg-surface/30 px-3 py-1.5 text-xs font-semibold text-content-muted hover:text-content hover:border-content-muted disabled:opacity-50'
export const HUB_BTN = 'text-[11px] font-medium text-accent bg-accent/10 border border-accent/30 px-2 py-0.5 rounded hover:bg-accent/20 hover:border-accent/50 disabled:opacity-50'
export const SHARE_LINK_BTN = 'text-[11px] font-medium text-accent bg-accent/10 border border-accent/30 px-2 py-0.5 rounded hover:bg-accent/20 hover:border-accent/50'
