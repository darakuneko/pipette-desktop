// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members that run the sync in the Tauri build and report on it:
// the sync of a scope, the Analyze sync, the sync format status, and the
// progress, format and applied-unit events.
// None is backed by a backend command yet; until one is, the shim answers
// it with the fixed answer of fakes.ts or the stub of create-vial-api.ts.
// coverage.test.ts lists the members each of these modules holds.

import type { VialAPI } from '../../shared/types/vial-api'

export const syncExecuteApi = {} satisfies Partial<VialAPI>
