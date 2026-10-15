// SPDX-License-Identifier: GPL-2.0-or-later
// Builds a VialAPI whose members fall back to inert stubs when the Tauri
// backend does not provide them yet.

import type { VialAPI } from '../shared/types/vial-api'

type VialApiMember = VialAPI[keyof VialAPI]

/** Subscription members (`syncOnProgress`, `onWindowVisibilityChanged`, ...)
 *  return an unsubscribe function synchronously instead of a Promise. */
const LISTENER_NAME = /^on[A-Z]|On[A-Z]/

function stubFor(name: string): VialApiMember {
  if (LISTENER_NAME.test(name)) {
    return (() => () => {}) as unknown as VialApiMember
  }
  return ((...args: unknown[]) => {
    console.debug(`[vialAPI shim] ${name} is not implemented`, args)
    return Promise.resolve(undefined)
  }) as unknown as VialApiMember
}

/**
 * Returns `implemented` as a full VialAPI: any member it lacks resolves to a
 * stub, created once per name so repeated reads return the same function
 * (React effect dependencies compare by identity).
 */
export function createVialApi(implemented: Partial<VialAPI>): VialAPI {
  const stubs = new Map<string, VialApiMember>()
  return new Proxy(implemented as VialAPI, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string' || prop in target) {
        return Reflect.get(target, prop, receiver)
      }
      let stub = stubs.get(prop)
      if (!stub) {
        stub = stubFor(prop)
        stubs.set(prop, stub)
      }
      return stub
    },
  })
}
