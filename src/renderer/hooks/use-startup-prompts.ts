// SPDX-License-Identifier: GPL-2.0-or-later

import { useStartupNotification } from './useStartupNotification'
import { useUpdateCheck } from './useUpdateCheck'

/** The two modals a launch may bring up, in order: the startup notices,
 *  then the update, once the notices are done. */
export function useStartupPrompts() {
  const startupNotification = useStartupNotification()
  const updateCheck = useUpdateCheck(startupNotification)
  return { startupNotification, updateCheck }
}
