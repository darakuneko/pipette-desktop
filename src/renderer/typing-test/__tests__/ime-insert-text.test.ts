// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, afterEach } from 'vitest'
import { isLinuxWebView, toInsertedText } from '../ime-insert-text'

describe('toInsertedText', () => {
  it('returns the committed character of an insertText input', () => {
    expect(toInsertedText('insertText', 'ó')).toBe('ó')
  })

  it('normalizes a base letter plus combining mark to its NFC form', () => {
    expect(toInsertedText('insertText', 'ó')).toBe('ó')
  })

  it.each([
    ['insertText', ''],
    ['insertText', null],
    ['insertCompositionText', 'ó'],
    ['insertFromComposition', 'ó'],
    ['deleteCompositionText', null],
    ['insertFromPaste', 'ó'],
    ['insertFromDrop', 'ó'],
    ['insertReplacementText', 'ó'],
  ] as const)('returns null for %s with data %j', (inputType, data) => {
    expect(toInsertedText(inputType, data)).toBeNull()
  })
})

describe('isLinuxWebView', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubUserAgent(userAgent: string): void {
    vi.stubGlobal('navigator', { userAgent })
  }

  it('is true for a WebKitGTK user agent', () => {
    stubUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)')
    expect(isLinuxWebView()).toBe(true)
  })

  it('is true for a jsdom-style lowercase (linux) user agent', () => {
    stubUserAgent('Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/26.0.0')
    expect(isLinuxWebView()).toBe(true)
  })

  it('is false for Windows and macOS user agents', () => {
    stubUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0')
    expect(isLinuxWebView()).toBe(false)
    stubUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)')
    expect(isLinuxWebView()).toBe(false)
  })

  it('is false when navigator is undefined', () => {
    vi.stubGlobal('navigator', undefined)
    expect(isLinuxWebView()).toBe(false)
  })
})
