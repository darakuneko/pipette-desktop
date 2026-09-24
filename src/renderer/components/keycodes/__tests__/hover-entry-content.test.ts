// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi } from 'vitest'
import type { TFunction } from 'i18next'
import { buildHoverContent } from '../hover-entry-content'
import { resolveHoverEntry, type HoverEntrySources } from '../hover-entry'
import type { AltRepeatKeyEntry, ComboEntry, KeyOverrideEntry, TapDanceEntry } from '../../../../shared/types/protocol'
import { AltRepeatKeyOptions, KeyOverrideOptions } from '../../../../shared/types/protocol'

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  codeToLabel: (code: number) => `code-${code}`,
}))

// Echoes the key and its options so the assertions pin the exact i18n keys.
const t = ((key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}(${Object.values(opts).join(',')})` : key) as unknown as TFunction

const NONE = 'editor.hoverDetails.none'

const td = (o: Partial<TapDanceEntry> = {}): TapDanceEntry => ({ onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200, ...o })
const combo = (o: Partial<ComboEntry> = {}): ComboEntry => ({ key1: 0, key2: 0, key3: 0, key4: 0, output: 0, ...o })
const ko = (o: Partial<KeyOverrideEntry> = {}): KeyOverrideEntry => ({
  triggerKey: 0, replacementKey: 0, layers: 0, triggerMods: 0, negativeMods: 0, suppressedMods: 0, options: 0, enabled: false, ...o,
})
const ark = (o: Partial<AltRepeatKeyEntry> = {}): AltRepeatKeyEntry => ({ lastKey: 0, altKey: 0, allowedMods: 0, options: 0, enabled: false, ...o })

function rows(entry: Parameters<typeof buildHoverContent>[0], index = 2): [string, string][] {
  return buildHoverContent(entry, index, t).rows.map((r) => [r.label, r.value])
}

describe('resolveHoverEntry — the tiles\' "configured" rules', () => {
  const sources: HoverEntrySources = {
    macro: [[], [{ type: 'delay', delay: 5 }]],
    tapDance: [td(), td({ onDoubleTap: 4 }), td({ tappingTerm: 150 })],
    combo: [combo({ key3: 4, output: 5 }), combo({ key2: 4 })],
    keyOverride: [ko({ layers: 0xffff, options: 7 }), ko({ enabled: true }), ko({ replacementKey: 4 })],
    altRepeatKey: [ark({ allowedMods: 1 }), ark({ enabled: true }), ark({ altKey: 4 })],
  }

  it.each([
    ['macro', 0, false], ['macro', 1, true], ['macro', 9, false],
    ['tapDance', 0, false], ['tapDance', 1, true], ['tapDance', 2, false],
    ['combo', 0, false], ['combo', 1, true],
    ['keyOverride', 0, false], ['keyOverride', 1, true], ['keyOverride', 2, true],
    ['altRepeatKey', 0, false], ['altRepeatKey', 1, true], ['altRepeatKey', 2, true],
  ] as const)('%s %i configured: %s', (kind, index, configured) => {
    expect(resolveHoverEntry(sources, kind, index) !== null).toBe(configured)
  })

  it('returns null when the kind has no data', () => {
    expect(resolveHoverEntry({}, 'combo', 0)).toBeNull()
  })
})

describe('buildHoverContent', () => {
  it('lists every macro action with the tile prefixes', () => {
    const content = buildHoverContent({ kind: 'macro', value: [{ type: 'tap', keycodes: [4, 5] }, { type: 'text', text: 'a  b' }] }, 3, t)
    expect(content.title).toBe('M3')
    expect(content.layout).toBe('prefix')
    expect(content.rows.map((r) => [r.label, r.value])).toEqual([['T', 'code-4 code-5'], ['Tx', 'a  b']])
  })

  it('shows every Tap Dance field, including the tapping term and empty keys', () => {
    const content = buildHoverContent({ kind: 'tapDance', value: td({ onTap: 4, onTapHold: 7, tappingTerm: 175 }) }, 5, t)
    expect(content.title).toBe('editor.tapDance.editTitle(5)')
    expect(content.layout).toBe('table')
    expect(content.rows.map((r) => [r.label, r.value])).toEqual([
      ['editor.tapDance.onTap', 'code-4'],
      ['editor.tapDance.onHold', NONE],
      ['editor.tapDance.onDoubleTap', NONE],
      ['editor.tapDance.onTapHold', 'code-7'],
      ['editor.tapDance.tappingTerm', '175'],
    ])
  })

  it('shows all four Combo keys and the output, naming empty ones', () => {
    expect(buildHoverContent({ kind: 'combo', value: combo({ key1: 4, key2: 5, output: 6 }) }, 1, t).title).toBe('editor.combo.editTitle(1)')
    expect(rows({ kind: 'combo', value: combo({ key1: 4, key2: 5, output: 6 }) })).toEqual([
      ['editor.combo.key(1)', 'code-4'],
      ['editor.combo.key(2)', 'code-5'],
      ['editor.combo.key(3)', NONE],
      ['editor.combo.key(4)', NONE],
      ['editor.combo.output', 'code-6'],
    ])
  })

  it('shows every Key Override field with empty masks as none', () => {
    expect(rows({ kind: 'keyOverride', value: ko({ triggerKey: 4 }) })).toEqual([
      ['editor.keyOverride.enabled', 'editor.hoverDetails.off'],
      ['editor.keyOverride.triggerKey', 'code-4'],
      ['editor.keyOverride.replacementKey', NONE],
      ['editor.keyOverride.layers', NONE],
      ['editor.keyOverride.triggerMods', NONE],
      ['editor.keyOverride.negativeMods', NONE],
      ['editor.keyOverride.suppressedMods', NONE],
      ['editor.keyOverride.options', NONE],
    ])
  })

  it('names every layer, modifier and option of full Key Override masks', () => {
    const allOptions = Object.values(KeyOverrideOptions).filter((v): v is number => typeof v === 'number').reduce((a, b) => a | b, 0)
    const value = ko({ enabled: true, triggerKey: 4, replacementKey: 5, layers: 0xffff, triggerMods: 0xff, negativeMods: 0x11, suppressedMods: 0x80, options: allOptions })
    expect(rows({ kind: 'keyOverride', value })).toEqual([
      ['editor.keyOverride.enabled', 'editor.hoverDetails.on'],
      ['editor.keyOverride.triggerKey', 'code-4'],
      ['editor.keyOverride.replacementKey', 'code-5'],
      ['editor.keyOverride.layers', '0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15'],
      ['editor.keyOverride.triggerMods', 'LCtrl LShift LAlt LGui RCtrl RShift RAlt RGui'],
      ['editor.keyOverride.negativeMods', 'LCtrl RCtrl'],
      ['editor.keyOverride.suppressedMods', 'RGui'],
      ['editor.keyOverride.options', 'ActivationTriggerDown, ActivationRequired, ActivationNegativeModUp, OneShot, NoReregister, NoUnregisterOnOther'],
    ])
  })

  it('shows every Alt Repeat Key field, including a disabled entry and each option', () => {
    expect(buildHoverContent({ kind: 'altRepeatKey', value: ark({ lastKey: 4 }) }, 7, t).title).toBe('editor.altRepeatKey.editTitle(7)')
    expect(rows({ kind: 'altRepeatKey', value: ark({ lastKey: 4 }) })).toEqual([
      ['editor.altRepeatKey.enabled', 'editor.hoverDetails.off'],
      ['editor.altRepeatKey.lastKey', 'code-4'],
      ['editor.altRepeatKey.altKey', NONE],
      ['editor.altRepeatKey.allowedMods', NONE],
      ['editor.altRepeatKey.options', NONE],
    ])
    const value = ark({ enabled: true, lastKey: 4, altKey: 5, allowedMods: 0x22, options: AltRepeatKeyOptions.Bidirectional })
    expect(rows({ kind: 'altRepeatKey', value }).slice(3)).toEqual([
      ['editor.altRepeatKey.allowedMods', 'LShift RShift'],
      ['editor.altRepeatKey.options', 'Bidirectional'],
    ])
  })
})
