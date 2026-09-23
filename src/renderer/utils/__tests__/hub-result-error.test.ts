// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi } from 'vitest'
import { HUB_ERROR_ACCOUNT_DEACTIVATED, HUB_ERROR_RATE_LIMITED } from '../../../shared/types/hub'
import { hubResultErrorMessage } from '../hub-result-error'

const tIdentity = ((k: string) => k) as unknown as Parameters<typeof hubResultErrorMessage>[2]

describe('hubResultErrorMessage', () => {
  it('records the deactivation once and shows the deactivated message', () => {
    const onDeactivated = vi.fn()
    expect(hubResultErrorMessage(HUB_ERROR_ACCOUNT_DEACTIVATED, 'Upload failed', tIdentity, onDeactivated))
      .toBe('hub.accountDeactivated')
    expect(onDeactivated).toHaveBeenCalledTimes(1)
  })

  it('shows the rate limit message without recording a deactivation', () => {
    const onDeactivated = vi.fn()
    expect(hubResultErrorMessage(HUB_ERROR_RATE_LIMITED, 'Upload failed', tIdentity, onDeactivated))
      .toBe('hub.rateLimited')
    expect(onDeactivated).not.toHaveBeenCalled()
  })

  it('shows any other error text as-is', () => {
    const onDeactivated = vi.fn()
    expect(hubResultErrorMessage('Hub upload failed: 500 boom', 'Upload failed', tIdentity, onDeactivated))
      .toBe('Hub upload failed: 500 boom')
    expect(onDeactivated).not.toHaveBeenCalled()
  })

  it('shows the fallback when the error is missing or empty', () => {
    const onDeactivated = vi.fn()
    expect(hubResultErrorMessage(undefined, 'Upload failed', tIdentity, onDeactivated)).toBe('Upload failed')
    expect(hubResultErrorMessage('', 'Upload failed', tIdentity, onDeactivated)).toBe('Upload failed')
    expect(onDeactivated).not.toHaveBeenCalled()
  })
})
