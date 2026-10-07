// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useMemo, type ReactNode } from 'react'
import type { UseDevicePrefsReturn } from '../../hooks/device-prefs-types'
import { EntryHoverPreviewContext } from './entry-hover-context'
import { KeycodeTabOrderContext } from './keycode-tab-order-context'

type PickerPrefs = Pick<UseDevicePrefsReturn, 'entryHoverPreview' | 'keycodeTabOrder' | 'setKeycodeTabOrder' | 'appliedUid' | 'holdSyncReload'>

/** Provides the per-keyboard settings every key picker reads — the entry
 *  hover toggle (`entry-hover-context.ts`) and the tab order
 *  (`keycode-tab-order-context.ts`) — without threading them through each
 *  modal's props. */
export function PickerPrefsProvider({ devicePrefs, children }: { devicePrefs: PickerPrefs; children: ReactNode }) {
  const { entryHoverPreview, keycodeTabOrder, setKeycodeTabOrder, appliedUid, holdSyncReload } = devicePrefs
  const holdOrderReload = useCallback(() => holdSyncReload('keycodeTabOrder'), [holdSyncReload])
  const tabOrder = useMemo(
    () => ({ order: keycodeTabOrder, setOrder: setKeycodeTabOrder, scopeKey: appliedUid, holdOrderReload }),
    [keycodeTabOrder, setKeycodeTabOrder, appliedUid, holdOrderReload],
  )
  return (
    <EntryHoverPreviewContext.Provider value={entryHoverPreview}>
      <KeycodeTabOrderContext.Provider value={tabOrder}>{children}</KeycodeTabOrderContext.Provider>
    </EntryHoverPreviewContext.Provider>
  )
}
