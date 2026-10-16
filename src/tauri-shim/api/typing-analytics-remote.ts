// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI typing analytics members that read Drive in the Tauri build:
// whether Drive has typing data, the remote devices and days, and the fetch
// of a remote day.
// None is backed by a backend command yet; until one is, the shim answers
// it with the fixed answer of fakes.ts or the stub of create-vial-api.ts.
// coverage.test.ts lists the members each of these modules holds.

import type { VialAPI } from '../../shared/types/vial-api'

export const typingAnalyticsRemoteApi = {} satisfies Partial<VialAPI>
