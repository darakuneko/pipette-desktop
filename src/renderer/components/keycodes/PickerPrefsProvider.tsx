// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo, type ReactNode } from 'react'
import type { UseDevicePrefsReturn } from '../../hooks/device-prefs-types'
import { EntryHoverPreviewContext } from './entry-hover-context'
import { KeycodeTabOrderContext } from './keycode-tab-order-context'

type PickerPrefs = Pick<UseDevicePrefsReturn, 'entryHoverPreview' | 'keycodeTabOrder' | 'setKeycodeTabOrder' | 'appliedUid'>

/** Provides the per-keyboard settings every key picker reads — the entry
 *  hover toggle (`entry-hover-context.ts`) and the tab order
 *  (`keycode-tab-order-context.ts`) — without threading them through each
 *  modal's props. */
export function PickerPrefsProvider({ devicePrefs, children }: { devicePrefs: PickerPrefs; children: ReactNode }) {
  const { entryHoverPreview, keycodeTabOrder, setKeycodeTabOrder, appliedUid } = devicePrefs
  const tabOrder = useMemo(
    () => ({ order: keycodeTabOrder, setOrder: setKeycodeTabOrder, scopeKey: appliedUid }),
    [keycodeTabOrder, setKeycodeTabOrder, appliedUid],
  )
  return (
    <EntryHoverPreviewContext.Provider value={entryHoverPreview}>
      <KeycodeTabOrderContext.Provider value={tabOrder}>{children}</KeycodeTabOrderContext.Provider>
    </EntryHoverPreviewContext.Provider>
  )
}
