// SPDX-License-Identifier: GPL-2.0-or-later
// The value a VialAPI member resolves with, for the Hub modules' `call`.

import type { VialAPI } from '../../shared/types/vial-api'

export type Answer<K extends keyof VialAPI> = VialAPI[K] extends (...args: never[]) => Promise<infer R> ? R : never
