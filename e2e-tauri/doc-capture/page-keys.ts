// SPDX-License-Identifier: GPL-2.0-or-later
//
// The keys of the capture's `page.keyboard` (page.ts), from Playwright's key
// names to the WebDriver key values: a named key (`Escape`, `Shift`, ...) to
// its code point of the WebDriver key table, a `KeyboardEvent.code` name of a
// character key (`KeyW`, `BracketLeft`, `Digit1`, ...) to the character the
// key types without Shift (WebDriver derives the `code` of the event from
// that character), and any other single character to itself.

/** The WebDriver key values of the named keys the capture presses. */
const NAMED_KEYS: Record<string, string> = {
  Backspace: '',
  Tab: '',
  Enter: '',
  Shift: '',
  Control: '',
  Alt: '',
  Escape: '',
  Space: ' ',
  Meta: '',
}

/** The unshifted characters of the `KeyboardEvent.code` names of the
 *  punctuation keys of a US keyboard. */
const CODE_CHARACTERS: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`',
}

/** The WebDriver key value of the Playwright key name `key`. */
export function webdriverKey(key: string): string {
  const named = NAMED_KEYS[key] ?? CODE_CHARACTERS[key]
  if (named !== undefined) return named
  const letter = /^Key([A-Z])$/.exec(key)
  if (letter) return letter[1].toLowerCase()
  const digit = /^Digit([0-9])$/.exec(key)
  if (digit) return digit[1]
  if ([...key].length === 1) return key
  throw new Error(`the capture's keyboard does not know the key ${key}`)
}

/** The WebDriver key values of a Playwright key combination such as
 *  `Control+z` (the modifiers first), or of a single key. A `+` on its own
 *  or at the end is the plus key. */
export function keyCombo(combo: string): string[] {
  if (combo === '+' || !combo.includes('+')) return [webdriverKey(combo)]
  const parts = combo.endsWith('++') ? [...combo.slice(0, -2).split('+'), '+'] : combo.split('+')
  if (parts.some((part) => part === '')) throw new Error(`the key combination ${combo} has an empty key`)
  return parts.map(webdriverKey)
}
