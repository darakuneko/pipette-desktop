// SPDX-License-Identifier: GPL-2.0-or-later
// Builds a complete VialAPI from the members the Tauri backend implements,
// filling every other member with an inert stub so the renderer can start.

import type { VialAPI } from '../shared/types/vial-api'
import {
  VIAL_API_MEMBER_KINDS,
  VIAL_API_MEMBER_NAMES,
  type VialApiMemberKind,
  type VialApiMemberName,
} from './vial-api-members'

/** Listeners return a no-op unsubscribe; requests resolve with undefined.
 *  Both warn on the first call only, so a member polled in a loop does not
 *  flood the console. */
function unimplemented(name: VialApiMemberName, kind: VialApiMemberKind): () => unknown {
  let warned = false
  const warnOnce = (): void => {
    if (warned) return
    warned = true
    console.warn(`[vialAPI shim] ${name} is not implemented`)
  }
  if (kind === 'listener') {
    return () => {
      warnOnce()
      return () => {}
    }
  }
  return () => {
    warnOnce()
    return Promise.resolve(undefined)
  }
}

/**
 * Returns a plain object with every VialAPI member, built once: the entry
 * from `implemented` where there is one, otherwise a stub. Each member is a
 * single function for the life of the object, so React effect dependencies
 * that hold a member compare equal across renders.
 */
export function createVialApi(implemented: Partial<VialAPI>): VialAPI {
  const api: Partial<Record<VialApiMemberName, unknown>> = {}
  for (const name of VIAL_API_MEMBER_NAMES) {
    api[name] = implemented[name] ?? unimplemented(name, VIAL_API_MEMBER_KINDS[name])
  }
  return api as VialAPI
}
