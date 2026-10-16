// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members of the sync password change of the Tauri build: the
// change, its status, resume, revert, abandon, the undecryptable files and
// the Drive locks.
// None is backed by a backend command yet; until one is, the shim answers
// it with the fixed answer of fakes.ts or the stub of create-vial-api.ts.
// coverage.test.ts lists the members each of these modules holds.

import type { VialAPI } from '../../shared/types/vial-api'

export const syncPasswordChangeApi = {} satisfies Partial<VialAPI>
