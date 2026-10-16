// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members of the Google sign-in of the Tauri build: start, status
// and sign-out.
// None is backed by a backend command yet; until one is, the shim answers
// it with the fixed answer of fakes.ts or the stub of create-vial-api.ts.
// coverage.test.ts lists the members each of these modules holds.

import type { VialAPI } from '../../shared/types/vial-api'

export const syncAuthApi = {} satisfies Partial<VialAPI>
