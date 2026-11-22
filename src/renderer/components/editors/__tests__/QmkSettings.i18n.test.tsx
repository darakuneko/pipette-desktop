// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import i18next, { type i18n as I18n } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { QmkSettings } from '../QmkSettings'

const PACK_LNG = 'pack:test'

// The "Grave Escape" tab has four boolean rows on qsid 1 (bits 0-3). The pack
// translates bit 0 only and the English resources carry bits 0 and 1, worded
// differently from the defs titles so each row shows which source it came
// from: bit 0 the pack, bit 1 English, bit 2 the defs title.
const ENGLISH_FIELDS = { q1_b0: 'ENGLISH alt label', q1_b1: 'ENGLISH control label' }

let instance: I18n

beforeAll(async () => {
  instance = i18next.createInstance()
  await instance.init({
    resources: {
      'builtin:en': { translation: { qmkSettingsField: ENGLISH_FIELDS } },
      [PACK_LNG]: { translation: { qmkSettingsField: { q1_b0: 'PACK alt label' } } },
    },
    lng: PACK_LNG,
    fallbackLng: 'builtin:en',
    keySeparator: '.',
    interpolation: { escapeValue: false },
  })
})

describe('QmkSettings field labels', () => {
  it('uses the pack translation, then English, then the defs title', async () => {
    render(
      <I18nextProvider i18n={instance}>
        <QmkSettings
          tabName="Grave Escape"
          supportedQsids={new Set([1])}
          qmkSettingsGet={vi.fn(async () => [0])}
          qmkSettingsSet={vi.fn(async () => {})}
          qmkSettingsReset={vi.fn(async () => {})}
        />
      </I18nextProvider>,
    )

    expect(await screen.findByText('PACK alt label')).toBeTruthy()
    expect(screen.getByText('ENGLISH control label')).toBeTruthy()
    expect(screen.getByText('Always send Escape if GUI is pressed')).toBeTruthy()
    expect(screen.queryByText('qmkSettingsField.q1_b2')).toBeNull()
  })
})
