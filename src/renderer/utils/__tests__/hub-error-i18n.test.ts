// SPDX-License-Identifier: GPL-2.0-or-later
//
// Direct coverage for the renderer-side Hub error → i18n key mapping.
// Stubs out the t() function with an identity returning the key, so
// the assertions verify the *mapping* without dragging the live i18n
// resource bundle into the test.

import { describe, it, expect } from 'vitest'
import {
  HUB_ERROR_ACCOUNT_DEACTIVATED,
  HUB_ERROR_RATE_LIMITED,
} from '../../../shared/types/hub'
import { localizeHubError } from '../hub-error-i18n'

const tIdentity = ((k: string) => k) as unknown as Parameters<typeof localizeHubError>[2]

describe('localizeHubError', () => {
  it('returns the fallback key when raw is undefined / empty', () => {
    expect(localizeHubError(undefined, 'hub.uploadFailed', tIdentity)).toBe('hub.uploadFailed')
    expect(localizeHubError('', 'hub.uploadFailed', tIdentity)).toBe('hub.uploadFailed')
  })

  it('maps server sentinels to the dedicated key', () => {
    expect(localizeHubError(HUB_ERROR_ACCOUNT_DEACTIVATED, 'hub.uploadFailed', tIdentity)).toBe('hub.accountDeactivated')
    expect(localizeHubError(HUB_ERROR_RATE_LIMITED, 'hub.uploadFailed', tIdentity)).toBe('hub.rateLimited')
  })

  it('maps prepareAnalyticsExport rejections to user-readable copy', () => {
    expect(localizeHubError('Saved filter entry not found', 'hub.uploadFailed', tIdentity)).toBe('hub.error.entryNotFound')
    expect(localizeHubError('No keymap snapshot recorded for this range', 'hub.uploadFailed', tIdentity)).toBe('hub.error.noSnapshot')
    expect(localizeHubError('Saved filter has no range', 'hub.uploadFailed', tIdentity)).toBe('hub.error.noRange')
    expect(localizeHubError('Invalid uid', 'hub.uploadFailed', tIdentity)).toBe('hub.error.invalidId')
    expect(localizeHubError('Invalid post ID', 'hub.uploadFailed', tIdentity)).toBe('hub.error.invalidId')
  })

  it('decodes INVALID_PAYLOAD reasons embedded inside HubHttpError bodies', () => {
    const raw = 'Hub analytics upload failed: 400 {"ok":false,"error":"INVALID_PAYLOAD: keystrokes below threshold"}'
    expect(localizeHubError(raw, 'hub.uploadFailed', tIdentity)).toBe('hub.error.keystrokesBelow')
  })

  it('handles each known INVALID_PAYLOAD reason', () => {
    const cases: Array<[string, string]> = [
      ['INVALID_PAYLOAD: keystrokes below threshold', 'hub.error.keystrokesBelow'],
      ['INVALID_PAYLOAD: range exceeds 30 days', 'hub.error.rangeExceeds'],
      ['INVALID_PAYLOAD: unsupported version', 'hub.error.unsupportedVersion'],
      ['INVALID_PAYLOAD: kind mismatch', 'hub.error.kindMismatch'],
      ['INVALID_PAYLOAD: minuteStats must be array', 'hub.error.malformedPayload'],
      ['INVALID_PAYLOAD: bigramTop must be array', 'hub.error.malformedPayload'],
      ['INVALID_PAYLOAD: peakRecords must be an object', 'hub.error.invalidPayload'],
    ]
    for (const [raw, key] of cases) {
      expect(localizeHubError(raw, 'hub.uploadFailed', tIdentity)).toBe(key)
    }
  })

  it('classifies HTTP status codes that the Hub server returns', () => {
    expect(localizeHubError('Hub analytics upload failed: 401 Unauthorized', 'hub.uploadFailed', tIdentity)).toBe('hub.error.authFailed')
    expect(localizeHubError('Hub analytics upload failed: 403 forbidden', 'hub.uploadFailed', tIdentity)).toBe('hub.accountDeactivated')
    expect(localizeHubError('Hub analytics upload failed: 413 too large', 'hub.uploadFailed', tIdentity)).toBe('hub.error.payloadTooLarge')
    expect(localizeHubError('Hub analytics upload failed: 429 slow down', 'hub.uploadFailed', tIdentity)).toBe('hub.rateLimited')
  })

  it('falls back to the supplied key for unrecognised strings', () => {
    expect(localizeHubError('Some other error', 'hub.updateFailed', tIdentity)).toBe('hub.updateFailed')
    expect(localizeHubError('network unreachable', 'hub.removeFailed', tIdentity)).toBe('hub.removeFailed')
  })
})
