// SPDX-License-Identifier: GPL-2.0-or-later
// Connected-view warning banners (dummy/pipette-file mode, unsaved
// changes, example UID, protocol version, connection warning). Split out
// of App.tsx (Task-split-app-tsx) to bring it under the file-splitting
// line-count target.

import { useTranslation } from 'react-i18next'
import type { useDeviceConnection } from '../hooks/useDeviceConnection'
import type { useKeyboard } from '../hooks/useKeyboard'
import type { useDeviceLifecycle } from '../hooks/useDeviceLifecycle'
import { EMPTY_UID } from '../../shared/constants/protocol'

interface Props {
  device: ReturnType<typeof useDeviceConnection>
  keyboard: ReturnType<typeof useKeyboard>
  lifecycle: ReturnType<typeof useDeviceLifecycle>
}

export function AppBanners({ device, keyboard, lifecycle }: Props) {
  const { t } = useTranslation()

  if (keyboard.loading) return null

  return (
    <>
      {device.isDummy && (
        <div className="flex items-center justify-between border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-warning">
          <span>{device.isPipetteFile ? t('error.pipetteFileMode') : t('error.dummyMode')}</span>
          {device.isPipetteFile && keyboard.activityCount > lifecycle.pipetteFileSavedActivityRef.current && (
            <span className="text-danger" data-testid="unsaved-indicator">
              {t('error.unsavedChanges')}
            </span>
          )}
        </div>
      )}

      {!device.isDummy && keyboard.uid === EMPTY_UID && (
        <div className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-warning">
          {t('error.exampleUid')}
        </div>
      )}

      {keyboard.viaProtocol > 0 && keyboard.viaProtocol < 9 && (
        <div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger">
          {t('error.protocolVersion')}
        </div>
      )}

      {keyboard.connectionWarning && (
        <div className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-warning">
          {t(keyboard.connectionWarning)}
        </div>
      )}
    </>
  )
}
