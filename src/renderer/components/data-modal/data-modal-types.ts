// SPDX-License-Identifier: GPL-2.0-or-later

import type { FavoriteType } from '../../../shared/types/favorite-store'

/** Discriminated union describing the active navigation path in the Data modal. */
export type DataNavPath =
  | { section: 'local'; page: 'keyboard'; uid: string; name: string }
  | { section: 'local'; page: 'favorite'; favoriteType: FavoriteType }
  | { section: 'local'; page: 'application' }
  | { section: 'local'; page: 'typing'; uid: string; name: string }
  | { section: 'sync'; page: 'sync-keyboard'; uid: string; name: string }
  | { section: 'sync'; page: 'sync-favorite'; favoriteType: string }
  | { section: 'sync'; page: 'sync-typing-device'; uid: string; name: string; machineHash: string; deviceLabel: string }
  | { section: 'hub'; page: 'hub-keyboard'; keyboardName: string }

/** Compute breadcrumb segments from a navigation path. */
export function breadcrumbSegments(
  path: DataNavPath,
  t: (key: string) => string,
): string[] {
  switch (path.page) {
    case 'keyboard':
      return [t('dataModal.local'), t('dataModal.keyboards'), path.name]
    case 'favorite':
      return [t('dataModal.local'), t('dataModal.favorites'), t(`editor.${path.favoriteType}.title`)]
    case 'application':
      return [t('dataModal.local'), t('dataModal.application')]
    case 'typing':
      return [t('dataModal.local'), t('dataModal.typing.title'), path.name]
    case 'sync-keyboard':
      return [t('dataModal.sync'), t('dataModal.keyboards'), path.name]
    case 'sync-favorite':
      return [t('dataModal.sync'), t('dataModal.favorites'), t(`editor.${path.favoriteType}.title`)]
    case 'sync-typing-device':
      return [t('dataModal.sync'), t('dataModal.typing.title'), path.name, path.deviceLabel]
    case 'hub-keyboard':
      return [t('dataModal.hub'), t('dataModal.keyboards'), path.keyboardName]
  }
}

/** Compute a title string from a navigation path. */
export function navTitle(
  path: DataNavPath,
  t: (key: string) => string,
): string {
  switch (path.page) {
    case 'keyboard':
      return path.name
    case 'favorite':
      return t(`editor.${path.favoriteType}.title`)
    case 'application':
      return t('dataModal.application')
    case 'typing':
      return path.name
    case 'sync-keyboard':
      return path.name
    case 'sync-favorite':
      return t(`editor.${path.favoriteType}.title`)
    case 'sync-typing-device':
      return `${path.name} — ${path.deviceLabel}`
    case 'hub-keyboard':
      return path.keyboardName
  }
}
