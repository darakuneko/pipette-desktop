// SPDX-License-Identifier: GPL-2.0-or-later
// The capture keyboard's key names: Playwright's names to WebDriver key
// values, and key combinations.

import { describe, expect, it } from 'vitest'
import { keyCombo, webdriverKey } from '../page-keys'

describe('webdriverKey', () => {
  it('maps the named keys to their WebDriver code points', () => {
    expect(webdriverKey('Escape')).toBe('')
    expect(webdriverKey('Enter')).toBe('')
    expect(webdriverKey('Backspace')).toBe('')
    expect(webdriverKey('Shift')).toBe('')
    expect(webdriverKey('Control')).toBe('')
  })

  it('maps the code names of character keys to their unshifted characters', () => {
    expect(webdriverKey('KeyW')).toBe('w')
    expect(webdriverKey('KeyE')).toBe('e')
    expect(webdriverKey('Digit7')).toBe('7')
    expect(webdriverKey('BracketLeft')).toBe('[')
    expect(webdriverKey('Minus')).toBe('-')
  })

  it('keeps a single character, the space and a non-Latin one too', () => {
    expect(webdriverKey('z')).toBe('z')
    expect(webdriverKey(' ')).toBe(' ')
    expect(webdriverKey('-')).toBe('-')
    expect(webdriverKey('か')).toBe('か')
  })

  it('refuses a name it does not know', () => {
    expect(() => webdriverKey('F13')).toThrow(/does not know the key F13/)
    expect(() => webdriverKey('')).toThrow()
  })
})

describe('keyCombo', () => {
  it('splits a combination into its keys, modifiers first', () => {
    expect(keyCombo('Control+z')).toEqual(['', 'z'])
    expect(keyCombo('Control+Shift+KeyZ')).toEqual(['', '', 'z'])
  })

  it('reads a single key, the plus key alone and a combination ending in it', () => {
    expect(keyCombo('Escape')).toEqual([''])
    expect(keyCombo('+')).toEqual(['+'])
    expect(keyCombo('Shift++')).toEqual(['', '+'])
  })

  it('refuses an empty key in a combination', () => {
    expect(() => keyCombo('Control++z')).toThrow(/empty key/)
  })
})
