// SPDX-License-Identifier: GPL-2.0-or-later
// Hub IPC: JWT cache + auth-retry wrapper shared across every
// hub-ipc-*.ts sibling. Split out of hub-ipc.ts to keep it under the
// project's 800-line Service/Util size ceiling.
//
// Module state lives on the exported `hubAuthState` object (mirrors
// sync-runtime-state.ts's `syncRuntime` convention) since a plain
// `export let x` cannot be reassigned from outside its declaring module.

import { HUB_ERROR_DISPLAY_NAME_CONFLICT, HUB_ERROR_ACCOUNT_DEACTIVATED, HUB_ERROR_RATE_LIMITED } from '../../shared/types/hub'
import { getIdToken } from '../sync/google-auth'
import { Hub401Error, Hub403Error, Hub409Error, Hub429Error, authenticateWithHub } from './hub-client'
import type { HubAuthResult } from './hub-client'

const AUTH_ERROR = 'Not authenticated with Google. Please sign in again.'

// Cache Hub JWT to avoid redundant /api/auth/token round-trips.
// Hub JWT is valid for 7 days; we cache for 24 hours.
// withTokenRetry() handles mid-cache expiry via automatic 401 retry.
// The /api/auth/token endpoint has a 10 req/min rate limit.
const HUB_JWT_TTL_MS = 24 * 60 * 60 * 1000

export const hubAuthState = {
  cachedHubJwt: null as { token: string; expiresAt: number } | null,
  inflightHubAuth: null as Promise<string> | null,
  cacheGeneration: 0,
  pendingAuthDisplayName: null as string | null,
}

export async function getHubToken(): Promise<string> {
  if (hubAuthState.cachedHubJwt && Date.now() < hubAuthState.cachedHubJwt.expiresAt) {
    return hubAuthState.cachedHubJwt.token
  }
  // Deduplicate concurrent requests
  if (hubAuthState.inflightHubAuth) return hubAuthState.inflightHubAuth
  const gen = hubAuthState.cacheGeneration
  const p = (async () => {
    try {
      const idToken = await getIdToken()
      if (!idToken) throw new Error(AUTH_ERROR)
      let auth: HubAuthResult
      try {
        auth = await authenticateWithHub(idToken, hubAuthState.pendingAuthDisplayName ?? undefined)
      } catch (err) {
        if (err instanceof Hub409Error) throw new Error(HUB_ERROR_DISPLAY_NAME_CONFLICT)
        rethrowAsHubSentinel(err)
        throw err
      }
      // Only cache if not invalidated (e.g. by sign-out) during the request
      if (gen === hubAuthState.cacheGeneration) {
        hubAuthState.cachedHubJwt = { token: auth.token, expiresAt: Date.now() + HUB_JWT_TTL_MS }
      }
      return auth.token
    } finally {
      hubAuthState.inflightHubAuth = null
    }
  })()
  hubAuthState.inflightHubAuth = p
  return p
}

export function clearHubTokenCache(): void {
  hubAuthState.cachedHubJwt = null
  hubAuthState.inflightHubAuth = null
  hubAuthState.cacheGeneration++
  hubAuthState.pendingAuthDisplayName = null
}

/** Called by the HUB_SET_AUTH_DISPLAY_NAME handler (hub-ipc-posts.ts). */
export function setPendingAuthDisplayName(name: string | null): void {
  hubAuthState.pendingAuthDisplayName = typeof name === 'string' ? name : null
  // Invalidate cached JWT so the next getHubToken() re-authenticates
  // with the new display name instead of returning a stale cached/inflight result.
  hubAuthState.cachedHubJwt = null
  hubAuthState.inflightHubAuth = null
}

function invalidateCachedHubJwt(): void {
  hubAuthState.cachedHubJwt = null
}

export function rethrowAsHubSentinel(err: unknown): void {
  if (err instanceof Hub403Error) throw new Error(HUB_ERROR_ACCOUNT_DEACTIVATED)
  if (err instanceof Hub429Error) throw new Error(HUB_ERROR_RATE_LIMITED)
}

export async function withTokenRetry<T>(operation: (jwt: string) => Promise<T>): Promise<T> {
  const jwt = await getHubToken()
  try {
    return await operation(jwt)
  } catch (err) {
    if (err instanceof Hub401Error) {
      invalidateCachedHubJwt()
      const freshJwt = await getHubToken()
      try {
        return await operation(freshJwt)
      } catch (retryErr) {
        rethrowAsHubSentinel(retryErr)
        throw retryErr
      }
    }
    rethrowAsHubSentinel(err)
    throw err
  }
}
