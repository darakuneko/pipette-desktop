// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  HUB_API_DEFAULT,
  isHubUrlOverrideAllowed,
  getHubApiBase,
  getHubOrigin,
  getHubTestAccount,
} from '../hub-base'

// Every getter reads process.env live, so no vi.resetModules dance is
// needed — stub per-case and read the fresh result directly.
const ENV_KEYS = [
  'ELECTRON_RENDERER_URL',
  'PIPETTE_HUB_TEST',
  'PIPETTE_HUB_URL',
  'PIPETTE_HUB_TEST_ACCOUNT',
] as const

describe('hub-base', () => {
  beforeEach(() => {
    // Ensure env vars don't leak in from the developer's shell
    for (const key of ENV_KEYS) delete process.env[key]
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('isHubUrlOverrideAllowed', () => {
    it('is false when neither dev renderer URL nor test flag is set', () => {
      expect(isHubUrlOverrideAllowed()).toBe(false)
    })

    it('is true in dev (ELECTRON_RENDERER_URL set)', () => {
      vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
      expect(isHubUrlOverrideAllowed()).toBe(true)
    })

    it('is true with PIPETTE_HUB_TEST=1 alone (production build)', () => {
      vi.stubEnv('PIPETTE_HUB_TEST', '1')
      expect(isHubUrlOverrideAllowed()).toBe(true)
    })

    it('is false for PIPETTE_HUB_TEST values other than 1', () => {
      vi.stubEnv('PIPETTE_HUB_TEST', 'true')
      expect(isHubUrlOverrideAllowed()).toBe(false)
    })
  })

  describe('getHubApiBase', () => {
    it('returns the default when no env is set', () => {
      expect(getHubApiBase()).toBe(HUB_API_DEFAULT)
    })

    it('honors PIPETTE_HUB_URL in dev mode', () => {
      vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
      vi.stubEnv('PIPETTE_HUB_URL', 'http://localhost:8787')
      expect(getHubApiBase()).toBe('http://localhost:8787')
    })

    it('honors PIPETTE_HUB_URL with PIPETTE_HUB_TEST=1 and no renderer URL', () => {
      vi.stubEnv('PIPETTE_HUB_TEST', '1')
      vi.stubEnv('PIPETTE_HUB_URL', 'http://localhost:8787')
      expect(getHubApiBase()).toBe('http://localhost:8787')
    })

    it('ignores PIPETTE_HUB_URL when neither gate is open', () => {
      vi.stubEnv('PIPETTE_HUB_URL', 'http://localhost:8787')
      expect(getHubApiBase()).toBe(HUB_API_DEFAULT)
    })

    it('strips trailing slashes from the override', () => {
      vi.stubEnv('PIPETTE_HUB_TEST', '1')
      vi.stubEnv('PIPETTE_HUB_URL', 'http://localhost:8787///')
      expect(getHubApiBase()).toBe('http://localhost:8787')
    })

    it('reads env live (no module-load caching)', () => {
      expect(getHubApiBase()).toBe(HUB_API_DEFAULT)
      vi.stubEnv('PIPETTE_HUB_TEST', '1')
      vi.stubEnv('PIPETTE_HUB_URL', 'http://localhost:8787')
      expect(getHubApiBase()).toBe('http://localhost:8787')
    })
  })

  describe('getHubOrigin', () => {
    it('matches getHubApiBase for the default', () => {
      expect(getHubOrigin()).toBe(HUB_API_DEFAULT)
    })

    it('matches getHubApiBase for an allowed override', () => {
      vi.stubEnv('PIPETTE_HUB_TEST', '1')
      vi.stubEnv('PIPETTE_HUB_URL', 'http://localhost:8787')
      expect(getHubOrigin()).toBe('http://localhost:8787')
    })
  })

  describe('getHubTestAccount', () => {
    it('returns null when unset', () => {
      expect(getHubTestAccount()).toBeNull()
    })

    it('returns null when the account is set but the base is the prod default (fail-closed)', () => {
      vi.stubEnv('PIPETTE_HUB_TEST_ACCOUNT', 'tester@example.com')
      expect(getHubTestAccount()).toBeNull()
    })

    it('returns null when the override is set but gated off (base falls back to prod)', () => {
      vi.stubEnv('PIPETTE_HUB_URL', 'http://localhost:8787')
      vi.stubEnv('PIPETTE_HUB_TEST_ACCOUNT', 'tester@example.com')
      expect(getHubTestAccount()).toBeNull()
    })

    it('returns null when the allowed override points at a non-local host', () => {
      vi.stubEnv('PIPETTE_HUB_TEST', '1')
      vi.stubEnv('PIPETTE_HUB_URL', 'https://example.com')
      vi.stubEnv('PIPETTE_HUB_TEST_ACCOUNT', 'tester@example.com')
      expect(getHubTestAccount()).toBeNull()
    })

    it('returns the account with the full triple pointing at localhost', () => {
      vi.stubEnv('PIPETTE_HUB_TEST', '1')
      vi.stubEnv('PIPETTE_HUB_URL', 'http://localhost:8787')
      vi.stubEnv('PIPETTE_HUB_TEST_ACCOUNT', 'tester@example.com')
      expect(getHubTestAccount()).toBe('tester@example.com')
    })

    it('rejects lookalike hosts that merely start with localhost', () => {
      vi.stubEnv('PIPETTE_HUB_TEST', '1')
      vi.stubEnv('PIPETTE_HUB_URL', 'http://localhost.evil.com:8787')
      vi.stubEnv('PIPETTE_HUB_TEST_ACCOUNT', 'tester@example.com')
      expect(getHubTestAccount()).toBeNull()
    })

    it('rejects userinfo tricks that put localhost before the real host', () => {
      vi.stubEnv('PIPETTE_HUB_TEST', '1')
      vi.stubEnv('PIPETTE_HUB_URL', 'http://localhost@evil.com:8787')
      vi.stubEnv('PIPETTE_HUB_TEST_ACCOUNT', 'tester@example.com')
      expect(getHubTestAccount()).toBeNull()
    })

    it('rejects IPv6 loopback (only localhost/127.0.0.1 are allowed)', () => {
      vi.stubEnv('PIPETTE_HUB_TEST', '1')
      vi.stubEnv('PIPETTE_HUB_URL', 'http://[::1]:8787')
      vi.stubEnv('PIPETTE_HUB_TEST_ACCOUNT', 'tester@example.com')
      expect(getHubTestAccount()).toBeNull()
    })

    it('accepts 127.0.0.1 as a local host', () => {
      vi.stubEnv('PIPETTE_HUB_TEST', '1')
      vi.stubEnv('PIPETTE_HUB_URL', 'http://127.0.0.1:8787')
      vi.stubEnv('PIPETTE_HUB_TEST_ACCOUNT', 'tester@example.com')
      expect(getHubTestAccount()).toBe('tester@example.com')
    })

    it('returns null when the override URL is malformed', () => {
      vi.stubEnv('PIPETTE_HUB_TEST', '1')
      vi.stubEnv('PIPETTE_HUB_URL', 'not a url')
      vi.stubEnv('PIPETTE_HUB_TEST_ACCOUNT', 'tester@example.com')
      expect(getHubTestAccount()).toBeNull()
    })
  })
})
