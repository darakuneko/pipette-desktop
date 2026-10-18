// SPDX-License-Identifier: GPL-2.0-or-later
// Fixed answers for VialAPI members whose backend area is not implemented
// yet. Every member is backed by backend commands, so there are none;
// coverage.test.ts lists the expected ones (an empty list).

import type { VialAPI } from '../shared/types/vial-api'

export const fakes = {} satisfies Partial<VialAPI>
