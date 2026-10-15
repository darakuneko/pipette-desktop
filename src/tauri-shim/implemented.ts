// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members the Tauri shim answers: the members the backend
// implements, one module per domain under ./api, and the fixed answers of
// ./fakes. Members in neither fall back to the stubs built in
// create-vial-api.ts; probeDevice is one of them, as probing a device
// without opening it has no backend command.

import type { VialAPI } from '../shared/types/vial-api'
import { deviceApi } from './api/device'
import { fakes } from './fakes'

/** The members backed by backend commands, by domain. */
export const real = {
  ...deviceApi,
} satisfies Partial<VialAPI>

export const implemented: Partial<VialAPI> = { ...real, ...fakes }
