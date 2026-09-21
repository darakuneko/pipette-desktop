// SPDX-License-Identifier: GPL-2.0-or-later
// Connected-view error banners below the editor surface for the three
// sources that fail independently: file export/import, JSON sideload, and
// the local layout store. Each gets its own `DismissibleError` so one
// source's timer or close button never affects the other two.

import { DismissibleError } from './ui/DismissibleError'
import type { useFileIO } from '../hooks/useFileIO'
import type { useSideloadJson } from '../hooks/useSideloadJson'
import type { useLayoutStore } from '../hooks/useLayoutStore'

const BANNER_CLASS = 'bg-danger/10 px-4 py-1.5 text-xs text-danger'

interface Props {
  fileIO: ReturnType<typeof useFileIO>
  sideload: ReturnType<typeof useSideloadJson>
  layoutStore: ReturnType<typeof useLayoutStore>
}

export function AppErrorBanner({ fileIO, sideload, layoutStore }: Props) {
  return (
    <>
      <DismissibleError message={fileIO.error} onDismiss={fileIO.clearError} className={BANNER_CLASS} testid="file-io-error-banner" />
      <DismissibleError message={sideload.error} onDismiss={sideload.clearError} className={BANNER_CLASS} testid="sideload-error-banner" />
      <DismissibleError message={layoutStore.error} onDismiss={layoutStore.clearError} className={BANNER_CLASS} testid="layout-store-error-banner" />
    </>
  )
}
