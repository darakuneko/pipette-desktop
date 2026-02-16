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
  startOAuthFlow,
} from '../sync/google-auth'
import { shell } from 'electron'

// We mock the global fetch for token exchange tests
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('google-auth', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
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
      // Create a valid JWT (exp in the future)
      const payload = { exp: Math.floor(Date.now() / 1000) + 3600 }
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

    it('preserves id_token after refresh', async () => {
      // Create a JWT that won't expire during the test
      const payload = { exp: Math.floor(Date.now() / 1000) + 7200 }
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

  describe('startOAuthFlow', () => {
    let mockServer: Server | null = null

    afterEach(async () => {
      if (mockServer) {
        await new Promise<void>((resolve) => mockServer!.close(() => resolve()))
        mockServer = null
      }
    })

    it('opens system browser with auth URL', async () => {
      // Setup: mock the token exchange
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

      // Wait for shell.openExternal to be called
      await vi.waitFor(() => {
        expect(shell.openExternal).toHaveBeenCalledOnce()
      })

      // Extract redirect URL from the auth URL that was opened
      const authUrl = vi.mocked(shell.openExternal).mock.calls[0][0]
      const parsed = new URL(authUrl)
      const redirectUri = parsed.searchParams.get('redirect_uri')!
      const state = parsed.searchParams.get('state')!

      // Simulate the OAuth callback using node:http (not global fetch which is mocked)
      const callbackUrl = `${redirectUri}?code=test-auth-code&state=${state}`
      const { get } = await import('node:http')
      await new Promise<void>((resolve) => {
        get(callbackUrl, (res) => {
          res.resume()
          resolve()
        }).on('error', () => resolve())
      })

      await flowPromise

      expect(mockFetch).toHaveBeenCalled()
    })
  })
})
