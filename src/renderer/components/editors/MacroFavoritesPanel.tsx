// SPDX-License-Identifier: GPL-2.0-or-later
//
// Favorites list and Hub upload controls for the macro editor, rendered
// by MacroEditor.tsx as a sibling of the editor column (not inside the
// action list). Hidden (`display: none`) while editing a slot; while a
// recording is in progress it stays laid out but `invisible`. Rendered
// only when the connected device isn't the dummy device.

import { useFavoriteStore } from '../../hooks/useFavoriteStore'
import { FavoriteStoreContent } from './FavoriteStoreContent'
import type { MacroAction } from '../../../preload/macro'
import type { Props as MacroEditorProps } from './macro-editor-types'

interface Props {
  isEditing: boolean
  isRecording: boolean
  favStore: ReturnType<typeof useFavoriteStore>
  currentActions: MacroAction[]
  hasInvalidText: boolean
  hubOrigin?: MacroEditorProps['hubOrigin']
  hubNeedsDisplayName?: MacroEditorProps['hubNeedsDisplayName']
  hubUploading?: MacroEditorProps['hubUploading']
  hubUploadResult?: MacroEditorProps['hubUploadResult']
  onUploadToHub?: MacroEditorProps['onUploadToHub']
  onUpdateOnHub?: MacroEditorProps['onUpdateOnHub']
  onRemoveFromHub?: MacroEditorProps['onRemoveFromHub']
  onRenameOnHub?: MacroEditorProps['onRenameOnHub']
}

export function MacroFavoritesPanel({
  isEditing,
  isRecording,
  favStore,
  currentActions,
  hasInvalidText,
  hubOrigin,
  hubNeedsDisplayName,
  hubUploading,
  hubUploadResult,
  onUploadToHub,
  onUpdateOnHub,
  onRemoveFromHub,
  onRenameOnHub,
}: Props) {
  return (
    <div
      className={`w-macro-editor shrink-0 flex flex-col ${isEditing ? 'hidden' : isRecording ? 'invisible' : ''}`}
      data-testid="macro-favorites-panel"
    >
      <FavoriteStoreContent
        entries={favStore.entries}
        loading={favStore.loading}
        saving={favStore.saving}
        canSave={currentActions.length > 0 && !hasInvalidText}
        onSave={favStore.saveFavorite}
        onLoad={favStore.loadFavorite}
        onRename={favStore.renameEntry}
        onDelete={favStore.deleteEntry}
        onExport={favStore.exportFavorites}
        onExportEntry={favStore.exportEntry}
        onImport={favStore.importFavorites}
        onExportCurrent={favStore.exportCurrent}
        onImportCurrent={favStore.importCurrent}
        exporting={favStore.exporting}
        importing={favStore.importing}
        importResult={favStore.importResult}
        hubOrigin={hubOrigin}
        hubNeedsDisplayName={hubNeedsDisplayName}
        hubUploading={hubUploading}
        hubUploadResult={hubUploadResult}
        onUploadToHub={onUploadToHub}
        onUpdateOnHub={onUpdateOnHub}
        onRemoveFromHub={onRemoveFromHub}
        onRenameOnHub={onRenameOnHub}
        onRefreshEntries={favStore.refreshEntries}
      />
    </div>
  )
}
