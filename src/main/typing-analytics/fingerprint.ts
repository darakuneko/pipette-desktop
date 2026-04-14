// SPDX-License-Identifier: GPL-2.0-or-later
// Build the fingerprint used to scope typing analytics data by machine
// / OS / keyboard. machineHash and OS details are gathered on demand.

import { arch, platform, release } from 'node:os'
import type {
  TypingAnalyticsFingerprint,
  TypingAnalyticsKeyboard,
} from '../../shared/types/typing-analytics'
import { getMachineHash } from './machine-hash'

export async function buildFingerprint(
  keyboard: TypingAnalyticsKeyboard,
): Promise<TypingAnalyticsFingerprint> {
  const machineHash = await getMachineHash()
  return {
    machineHash,
    os: {
      platform: platform(),
      release: release(),
      arch: arch(),
    },
    keyboard: {
      uid: keyboard.uid,
      vendorId: keyboard.vendorId,
      productId: keyboard.productId,
      productName: keyboard.productName,
    },
  }
}
