// SPDX-License-Identifier: GPL-2.0-or-later
//
// What the hover bubble shows for each entry kind. Field names reuse the
// editors' own i18n keys and keys are named with `codeToLabel`, like the
// tiles. Macros keep the tiles' one-letter action prefixes; every other
// kind is a "field name | value" table covering all of the entry's fields,
// including those the tile has no room for.

import type { TFunction } from 'i18next'
import { codeToLabel } from '../../../shared/keycodes/keycodes'
import {
  ALT_REPEAT_KEY_OPTION_ENTRIES, KEY_OVERRIDE_OPTION_ENTRIES, layerNumbers, modifierNames, optionNames,
} from '../editors/entry-flag-names'
import { MACRO_PREFIX, macroActionLabel } from './macro-action-format'
import type { HoverEntry } from './hover-entry'

export interface HoverRow {
  label: string
  value: string
}

export interface HoverContent {
  title: string
  /** `prefix`: a short action letter before each value (macros).
   *  `table`: a field name column and a value column. */
  layout: 'prefix' | 'table'
  rows: HoverRow[]
}

export function buildHoverContent(entry: HoverEntry, index: number, t: TFunction): HoverContent {
  const none = t('editor.hoverDetails.none')
  const key = (code: number): string => (code !== 0 ? codeToLabel(code) : none)
  const list = (items: readonly (string | number)[], separator: string): string =>
    items.length > 0 ? items.join(separator) : none
  const onOff = (on: boolean): string => t(on ? 'editor.hoverDetails.on' : 'editor.hoverDetails.off')

  switch (entry.kind) {
    case 'macro':
      return {
        title: `M${index}`,
        layout: 'prefix',
        rows: entry.value.map((action) => ({ label: MACRO_PREFIX[action.type], value: macroActionLabel(action) })),
      }
    case 'tapDance': {
      const e = entry.value
      return {
        title: t('editor.tapDance.editTitle', { index }),
        layout: 'table',
        rows: [
          { label: t('editor.tapDance.onTap'), value: key(e.onTap) },
          { label: t('editor.tapDance.onHold'), value: key(e.onHold) },
          { label: t('editor.tapDance.onDoubleTap'), value: key(e.onDoubleTap) },
          { label: t('editor.tapDance.onTapHold'), value: key(e.onTapHold) },
          { label: t('editor.tapDance.tappingTerm'), value: String(e.tappingTerm) },
        ],
      }
    }
    case 'combo': {
      const e = entry.value
      return {
        title: t('editor.combo.editTitle', { index }),
        layout: 'table',
        rows: [
          ...[e.key1, e.key2, e.key3, e.key4].map((code, i) => ({ label: t('editor.combo.key', { number: i + 1 }), value: key(code) })),
          { label: t('editor.combo.output'), value: key(e.output) },
        ],
      }
    }
    case 'keyOverride': {
      const e = entry.value
      return {
        title: t('editor.keyOverride.editTitle', { index }),
        layout: 'table',
        rows: [
          { label: t('editor.keyOverride.enabled'), value: onOff(e.enabled) },
          { label: t('editor.keyOverride.triggerKey'), value: key(e.triggerKey) },
          { label: t('editor.keyOverride.replacementKey'), value: key(e.replacementKey) },
          { label: t('editor.keyOverride.layers'), value: list(layerNumbers(e.layers), ', ') },
          { label: t('editor.keyOverride.triggerMods'), value: list(modifierNames(e.triggerMods), ' ') },
          { label: t('editor.keyOverride.negativeMods'), value: list(modifierNames(e.negativeMods), ' ') },
          { label: t('editor.keyOverride.suppressedMods'), value: list(modifierNames(e.suppressedMods), ' ') },
          { label: t('editor.keyOverride.options'), value: list(optionNames(e.options, KEY_OVERRIDE_OPTION_ENTRIES), ', ') },
        ],
      }
    }
    case 'altRepeatKey': {
      const e = entry.value
      return {
        title: t('editor.altRepeatKey.editTitle', { index }),
        layout: 'table',
        rows: [
          { label: t('editor.altRepeatKey.enabled'), value: onOff(e.enabled) },
          { label: t('editor.altRepeatKey.lastKey'), value: key(e.lastKey) },
          { label: t('editor.altRepeatKey.altKey'), value: key(e.altKey) },
          { label: t('editor.altRepeatKey.allowedMods'), value: list(modifierNames(e.allowedMods), ' ') },
          { label: t('editor.altRepeatKey.options'), value: list(optionNames(e.options, ALT_REPEAT_KEY_OPTION_ENTRIES), ', ') },
        ],
      }
    }
  }
}
