// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import english from '../locales/english.json'
import settingsDefs from '../../../shared/qmk-settings-defs.json'
import type { QmkSettingsTab } from '../../../shared/types/protocol'
import { QMK_SETTINGS_FIELD_NS, qmkSettingsFieldKey } from '../../../shared/qmk-settings-field-key'
import { flattenTranslations } from '../../../shared/i18n/coverage'
import { validatePack } from '../../../shared/i18n/validate'

const fields = (settingsDefs as { tabs: QmkSettingsTab[] }).tabs.flatMap((tab) => tab.fields)
const keys = fields.map(qmkSettingsFieldKey)
const englishFields = (english as Record<string, unknown>)[QMK_SETTINGS_FIELD_NS] as Record<string, unknown>
const englishFlat = flattenTranslations({ [QMK_SETTINGS_FIELD_NS]: englishFields ?? {} })

describe('qmkSettingsFieldKey', () => {
  it('uses the qsid, plus the bit when the field has one', () => {
    expect(qmkSettingsFieldKey({ qsid: 7 })).toBe('qmkSettingsField.q7')
    expect(qmkSettingsFieldKey({ qsid: 1, bit: 0 })).toBe('qmkSettingsField.q1_b0')
    expect(qmkSettingsFieldKey({ qsid: 21, bit: 9 })).toBe('qmkSettingsField.q21_b9')
  })
})

describe('QMK settings field keys vs english.json', () => {
  it('gives every field its own key', () => {
    expect(fields.length).toBeGreaterThan(0)
    expect(new Set(keys).size).toBe(fields.length)
  })

  it('every field key resolves in english.json to the field title', () => {
    const mismatches = fields
      .map((field) => ({ key: qmkSettingsFieldKey(field), title: field.title }))
      .filter(({ key, title }) => englishFlat[key] !== title)
      .map(({ key, title }) => `${key}: ${String(englishFlat[key])} !== ${title}`)
    expect(mismatches).toEqual([])
  })

  it('has no qmkSettingsField entries that no field uses', () => {
    const used = new Set(keys)
    const orphans = Object.keys(englishFlat).filter((key) => !used.has(key))
    expect(orphans).toEqual([])
  })

  it('a pack carrying every qmkSettingsField key passes validatePack', () => {
    const result = validatePack({ name: 'Test', version: '0.1.0', [QMK_SETTINGS_FIELD_NS]: englishFields })
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
  })
})
