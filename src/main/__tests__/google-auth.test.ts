// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Server } from 'node:http'

// --- Mock electron ---
vi.mock('electron', () => ({
  shell: {
    openExternal: vi.fn(async () => {}),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => {
      const str = b.toString()
      if (str.startsWith('enc:')) return str.slice(4)
      throw new Error('decrypt failed')
    }),
  },
  app: {
    getPath: (name: string) => `/mock/${name}`,
  },
}))

// Mock fs for token storage
vi.mock('node:fs/promises', () => {
  const store = new Map<string, Buffer | string>()
  return {
    writeFile: vi.fn(async (path: string, data: Buffer | string) => {
      store.set(path, typeof data === 'string' ? data : Buffer.from(data))
    }),
    readFile: vi.fn(async (path: string) => {
      const data = store.get(path)
      if (!data) throw new Error('ENOENT')
      return data
    }),
    unlink: vi.fn(async (path: string) => {
      if (!store.has(path)) throw new Error('ENOENT')
      store.delete(path)
    }),
    mkdir: vi.fn(async () => {}),
    // The token file is written temp-file-then-rename (`writeFileAtomic`).
    rename: vi.fn(async (from: string, to: string) => {
      const data = store.get(from)
      if (!data) throw new Error('ENOENT')
      store.delete(from)
      store.set(to, data)
    }),
    _testStore: store,
  }
})

import {
  generateAuthUrl,
  exchangeCodeForTokens,
  getAuthStatus,
  signOut,
  getAccessToken,
  getIdToken,
  getAccountSub,
  startOAuthFlow,
  tokenExchangeTiming,
} from '../sync/google-auth'
import { shell } from 'electron'

// We mock the global fetch for token exchange tests
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('google-auth', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    // Ensure Hub test-mode env vars don't leak from the developer's shell
    delete process.env.PIPETTE_HUB_TEST
    delete process.env.PIPETTE_HUB_URL
    delete process.env.PIPETTE_HUB_TEST_ACCOUNT
    const fs = await import('node:fs/promises')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(fs as any)._testStore.clear()
    mockFetch.mockReset()
    // Clear in-memory token cache between tests
    await signOut()
  })

  describe('generateAuthUrl', () => {
    it('generates a valid Google OAuth URL with required params', () => {
      const { url, codeVerifier, state } = generateAuthUrl(8080)

      const parsed = new URL(url)
      expect(parsed.hostname).toBe('accounts.google.com')
      expect(parsed.pathname).toBe('/o/oauth2/v2/auth')
      expect(parsed.searchParams.get('response_type')).toBe('code')
      expect(parsed.searchParams.get('scope')).toContain('drive.appdata')
      expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8080')
      expect(parsed.searchParams.get('state')).toBe(state)
      expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
      expect(parsed.searchParams.get('code_challenge')).toBeTruthy()
      expect(codeVerifier).toBeTruthy()
      expect(state).toBeTruthy()
    })

    it('generates unique state and code verifier each time', () => {
      const a = generateAuthUrl(8080)
      const b = generateAuthUrl(8080)

      expect(a.state).not.toBe(b.state)
      expect(a.codeVerifier).not.toBe(b.codeVerifier)
    })
  })

  describe('exchangeCodeForTokens', () => {
    it('exchanges auth code for tokens and stores them', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      })

      await exchangeCodeForTokens('auth-code', 'code-verifier', 8080)

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('https://oauth2.googleapis.com/token')
      expect(options.method).toBe('POST')
    })

    it('stores the tokens through the given switch', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer' }),
      })
      let signedInBeforeStore: boolean | null = null

      await exchangeCodeForTokens('auth-code', 'code-verifier', 8080, async (store) => {
        signedInBeforeStore = (await getAuthStatus()).authenticated
        await store()
      })

      expect(signedInBeforeStore).toBe(false)
      expect((await getAuthStatus()).authenticated).toBe(true)
    })

    it('throws on failed token exchange', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad Request',
      })

      await expect(
        exchangeCodeForTokens('bad-code', 'code-verifier', 8080),
      ).rejects.toThrow()
    })
  })

  describe('getAuthStatus', () => {
    it('returns unauthenticated when no tokens stored', async () => {
      const status = await getAuthStatus()
      expect(status.authenticated).toBe(false)
      expect(status.email).toBeUndefined()
    })

    it('returns authenticated after token exchange', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      })

      await exchangeCodeForTokens('auth-code', 'code-verifier', 8080)

      const status = await getAuthStatus()
      expect(status.authenticated).toBe(true)
    })
  })

  describe('signOut', () => {
    it('clears stored tokens', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      })

      await exchangeCodeForTokens('auth-code', 'code-verifier', 8080)
      await signOut()

      const status = await getAuthStatus()
      expect(status.authenticated).toBe(false)
    })
  })

  describe('getAccessToken', () => {
    it('returns null when not authenticated', async () => {
      const token = await getAccessToken()
      expect(token).toBeNull()
    })

    it('refreshes token when expired', async () => {
      // Initial token exchange
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'initial-token',
          refresh_token: 'refresh-token',
          expires_in: -1, // Already expired
          token_type: 'Bearer',
        }),
      })

      await exchangeCodeForTokens('auth-code', 'code-verifier', 8080)

      // Refresh response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'refreshed-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      })

      const token = await getAccessToken()
      expect(token).toBe('refreshed-token')
    })
  })

  describe('getIdToken', () => {
    it('returns null when not authenticated', async () => {
      const token = await getIdToken()
      expect(token).toBeNull()
    })

    it('returns null when id_token was not in exchange response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      })

      await exchangeCodeForTokens('code', 'verifier', 8080)

      const token = await getIdToken()
      expect(token).toBeNull()
    })

    it('returns null when id_token has no exp claim', async () => {
      const payload = { sub: 'user-id' }
      const noExpJwt = `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          id_token: noExpJwt,
        }),
      })

      await exchangeCodeForTokens('code', 'verifier', 8080)

      const token = await getIdToken()
      expect(token).toBeNull()
    })

    it('returns null when id_token is expired', async () => {
      // Create an expired JWT (exp in the past)
      const payload = { exp: Math.floor(Date.now() / 1000) - 3600 }
      const expiredJwt = `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          id_token: expiredJwt,
        }),
      })

      await exchangeCodeForTokens('code', 'verifier', 8080)

      const token = await getIdToken()
      expect(token).toBeNull()
    })

    it('returns id_token when not expired', async () => {
      // Create a valid JWT (exp in the future, iat now)
      const payload = { exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) }
      const validJwt = `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          id_token: validJwt,
        }),
      })

      await exchangeCodeForTokens('code', 'verifier', 8080)

      const token = await getIdToken()
      expect(token).toBe(validJwt)
    })

    it('returns null when id_token is stale and refresh does not return new one', async () => {
      // Create a JWT with old iat (> 5 min ago) but not expired
      const payload = { exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) - 600 }
      const staleJwt = `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`

      // Initial exchange with stale id_token
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          id_token: staleJwt,
        }),
      })

      await exchangeCodeForTokens('code', 'verifier', 8080)

      // Refresh response (no new id_token — preserved stale one)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'refreshed-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      })

      const token = await getIdToken()
      expect(token).toBeNull()
    })

    it('preserves id_token after refresh', async () => {
      // Create a JWT that won't expire during the test (iat now)
      const payload = { exp: Math.floor(Date.now() / 1000) + 7200, iat: Math.floor(Date.now() / 1000) }
      const validJwt = `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`

      // Initial exchange with id_token (access token expired to trigger refresh)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'initial-token',
          refresh_token: 'refresh-token',
          expires_in: -1, // Expired
          token_type: 'Bearer',
          id_token: validJwt,
        }),
      })

      await exchangeCodeForTokens('code', 'verifier', 8080)

      // Refresh response (no id_token)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'refreshed-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      })

      await getAccessToken() // Triggers refresh

      const token = await getIdToken()
      expect(token).toBe(validJwt)
    })
  })

  describe('a refresh racing a sign-in or sign-out', () => {
    function tokenResponse(extra: Record<string, unknown>): unknown {
      return {
        ok: true,
        json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer', ...extra }),
      }
    }

    /** Signs in with expired tokens and starts a refresh whose response
     *  waits for the returned `respond`. */
    async function startSlowRefresh(): Promise<{ respond: () => void; refreshed: Promise<string | null> }> {
      mockFetch.mockResolvedValueOnce(tokenResponse({ access_token: 'old', refresh_token: 'old-refresh', expires_in: -1 }))
      await exchangeCodeForTokens('code', 'verifier', 8080)
      let respond!: () => void
      mockFetch.mockImplementationOnce(() => new Promise((resolve) => {
        respond = () => resolve(tokenResponse({ access_token: 'refreshed-old' }))
      }))
      const refreshed = getAccessToken()
      await vi.waitFor(() => expect(respond).toBeTypeOf('function'))
      return { respond, refreshed }
    }

    it('does not sign back in when the refresh finishes after a sign-out', async () => {
      const { respond, refreshed } = await startSlowRefresh()

      await signOut()
      respond()

      expect(await refreshed).toBeNull()
      expect((await getAuthStatus()).authenticated).toBe(false)
    })

    it('does not replace a new sign-in\'s tokens when the refresh finishes after it', async () => {
      const { respond, refreshed } = await startSlowRefresh()

      mockFetch.mockResolvedValueOnce(tokenResponse({ access_token: 'new-account' }))
      await exchangeCodeForTokens('code-2', 'verifier', 8080)
      respond()

      expect(await refreshed).toBeNull()
      expect(await getAccessToken()).toBe('new-account')
    })
  })

  describe('a token write or read racing a sign-out', () => {
    const okResponse = {
      ok: true,
      json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer' }),
    }

    it('does not keep tokens whose write was under way when signing out', async () => {
      const fs = await import('node:fs/promises')
      let finishWrite!: () => void
      vi.mocked(fs.writeFile).mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          finishWrite = resolve
        })
      })
      mockFetch.mockResolvedValueOnce(okResponse)

      const signingIn = exchangeCodeForTokens('code', 'verifier', 8080)
      await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'))
      const signingOut = signOut()
      finishWrite()

      await expect(signingIn).rejects.toThrow()
      await signingOut
      expect((await getAuthStatus()).authenticated).toBe(false)
    })

    it('does not read back the token file a sign-out is still removing', async () => {
      mockFetch.mockResolvedValueOnce(okResponse)
      await exchangeCodeForTokens('code', 'verifier', 8080)
      const fs = await import('node:fs/promises')
      const realUnlink = vi.mocked(fs.unlink).getMockImplementation()
      let finishUnlink!: () => void
      vi.mocked(fs.unlink).mockImplementationOnce(async (path) => {
        await new Promise<void>((resolve) => {
          finishUnlink = resolve
        })
        await realUnlink?.(path)
      })

      const signingOut = signOut()
      const status = getAuthStatus()
      await vi.waitFor(() => expect(finishUnlink).toBeTypeOf('function'))
      finishUnlink()
      await signingOut

      expect((await status).authenticated).toBe(false)
    })
  })

  describe('a stalled token exchange', () => {
    afterEach(() => {
      tokenExchangeTiming.timeoutMs = 60_000
    })

    it('fails once the exchange timeout passes', async () => {
      tokenExchangeTiming.timeoutMs = 20
      // Never answers unless aborted.
      mockFetch.mockImplementationOnce((_url: string, init: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }))

      await expect(exchangeCodeForTokens('code', 'verifier', 8080)).rejects.toThrow('aborted')
      expect((await getAuthStatus()).authenticated).toBe(false)
    })

    it('fails a stalled refresh once the timeout passes, so no access token is returned', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'initial-token',
          refresh_token: 'refresh-token',
          expires_in: -1,
          token_type: 'Bearer',
        }),
      })
      await exchangeCodeForTokens('auth-code', 'code-verifier', 8080)
      tokenExchangeTiming.timeoutMs = 20
      let refreshSignal: AbortSignal | undefined
      // Never answers unless aborted.
      mockFetch.mockImplementationOnce((_url: string, init: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        refreshSignal = init.signal
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }))

      expect(await getAccessToken()).toBeNull()
      expect(refreshSignal?.aborted).toBe(true)
      expect((await getAuthStatus()).authenticated).toBe(true)
    })
  })

  describe('the token switch of a sign-in', () => {
    it('receives the new account\'s sub and stores nothing when it refuses', async () => {
      const jwt = `header.${Buffer.from(JSON.stringify({ sub: 'account-b' })).toString('base64url')}.sig`
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer', id_token: jwt }),
      })
      let receivedSub: string | null = null

      await expect(exchangeCodeForTokens('code', 'verifier', 8080, async (_store, sub) => {
        receivedSub = sub
        throw new Error('busy')
      })).rejects.toThrow('busy')

      expect(receivedSub).toBe('account-b')
      expect((await getAuthStatus()).authenticated).toBe(false)
    })
  })

  describe('getAccountSub', () => {
    const jwtWith = (payload: Record<string, unknown>): string =>
      `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`

    function tokenResponse(extra: Record<string, unknown>): unknown {
      return {
        ok: true,
        json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer', ...extra }),
      }
    }

    it('is null when signed out', async () => {
      expect(await getAccountSub()).toBeNull()
    })

    it('is the sub of the id_token received at sign-in', async () => {
      mockFetch.mockResolvedValueOnce(tokenResponse({ id_token: jwtWith({ sub: 'account-a' }) }))

      await exchangeCodeForTokens('code', 'verifier', 8080)

      expect(await getAccountSub()).toBe('account-a')
    })

    it('is null when the sign-in returned no id_token', async () => {
      mockFetch.mockResolvedValueOnce(tokenResponse({}))

      await exchangeCodeForTokens('code', 'verifier', 8080)

      expect(await getAccountSub()).toBeNull()
    })

    it('keeps the sub across a refresh that returns no id_token', async () => {
      mockFetch.mockResolvedValueOnce(tokenResponse({ id_token: jwtWith({ sub: 'account-a' }), expires_in: -1 }))
      await exchangeCodeForTokens('code', 'verifier', 8080)
      mockFetch.mockResolvedValueOnce(tokenResponse({ access_token: 'refreshed' }))

      expect(await getAccessToken()).toBe('refreshed')

      expect(await getAccountSub()).toBe('account-a')
    })
  })

  describe('Hub local test mode', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    function enableHubTestMode(email: string): void {
      vi.stubEnv('PIPETTE_HUB_TEST', '1')
      vi.stubEnv('PIPETTE_HUB_URL', 'http://localhost:8787')
      vi.stubEnv('PIPETTE_HUB_TEST_ACCOUNT', email)
    }

    it('getIdToken returns the sentinel token without touching stored tokens', async () => {
      enableHubTestMode('tester@example.com')
      const token = await getIdToken()
      expect(token).toBe('test:tester@example.com')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('getAuthStatus reports authenticated in test mode', async () => {
      enableHubTestMode('tester@example.com')
      const status = await getAuthStatus()
      expect(status.authenticated).toBe(true)
    })

    it('getAccountSub ignores the test account (it is not a Drive sign-in)', async () => {
      enableHubTestMode('tester@example.com')
      expect(await getAccountSub()).toBeNull()
    })

    it('getAccessToken stays null in test mode (Drive sync remains disabled)', async () => {
      enableHubTestMode('tester@example.com')
      const token = await getAccessToken()
      expect(token).toBeNull()
    })

    it('ignores the test account when the Hub base is the prod default (fail-closed)', async () => {
      vi.stubEnv('PIPETTE_HUB_TEST_ACCOUNT', 'tester@example.com')
      expect(await getIdToken()).toBeNull()
      expect((await getAuthStatus()).authenticated).toBe(false)
    })
  })

  describe('startOAuthFlow', () => {
    let mockServer: Server | null = null

    afterEach(async () => {
      if (mockServer) {
        await new Promise<void>((resolve) => mockServer!.close(() => resolve()))
        mockServer = null
      }
    })

    /** Wait for shell.openExternal and return the parsed auth URL params */
    async function waitForAuthRedirect(): Promise<{ redirectUri: string; state: string }> {
      await vi.waitFor(() => {
        expect(shell.openExternal).toHaveBeenCalledOnce()
      })

      const authUrl = vi.mocked(shell.openExternal).mock.calls[0][0]
      const parsed = new URL(authUrl)
      return {
        redirectUri: parsed.searchParams.get('redirect_uri')!,
        state: parsed.searchParams.get('state')!,
      }
    }

    /** Send an HTTP GET to the OAuth loopback server and drain the response */
    async function sendCallback(url: string): Promise<void> {
      const { get } = await import('node:http')
      await new Promise<void>((resolve) => {
        get(url, (res) => {
          res.resume()
          resolve()
        }).on('error', () => resolve())
      })
    }

    async function completeOAuthFlow(): Promise<void> {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'flow-token',
          refresh_token: 'flow-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      })

      const flowPromise = startOAuthFlow()
      const { redirectUri, state } = await waitForAuthRedirect()
      await sendCallback(`${redirectUri}?code=test-auth-code&state=${state}`)
      await flowPromise
    }

    it('opens system browser with auth URL', async () => {
      await completeOAuthFlow()
      expect(mockFetch).toHaveBeenCalled()
    })

    it('does not time out once the code is received, however long the token switch waits', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer' }),
        })
        let finishSwitch!: () => void
        let store!: () => Promise<void>
        const switchStarted = new Promise<void>((started) => {
          void startOAuthFlow((storeTokens) => {
            store = storeTokens
            started()
            return new Promise<void>((resolve) => {
              finishSwitch = resolve
            })
          }).then(() => {
            flowDone = 'resolved'
          }, () => {
            flowDone = 'rejected'
          })
        })
        let flowDone: 'pending' | 'resolved' | 'rejected' = 'pending'
        const { redirectUri, state } = await waitForAuthRedirect()
        await sendCallback(`${redirectUri}?code=test-auth-code&state=${state}`)
        await switchStarted

        await vi.advanceTimersByTimeAsync(6 * 60 * 1000)
        expect(flowDone).toBe('pending')

        await store()
        finishSwitch()
        await vi.waitFor(() => expect(flowDone).toBe('resolved'))
      } finally {
        vi.useRealTimers()
      }
    })

    it('clears timeout timer after successful flow', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        await completeOAuthFlow()
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('clears timeout timer after OAuth error', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const flowPromise = startOAuthFlow().catch((err: Error) => err)
        const { redirectUri } = await waitForAuthRedirect()
        await sendCallback(`${redirectUri}?error=access_denied`)

        const result = await flowPromise
        expect(result).toBeInstanceOf(Error)
        expect((result as Error).message).toBe('OAuth error: access_denied')
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
