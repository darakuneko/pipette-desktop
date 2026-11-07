// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import i18next, { type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { PopoverTabKey } from '../PopoverTabKey'

const pack = {
  keycodeTooltip: {
    KC_NONUS_HASH: 'Hash translated',
    MOD_LSFT: 'Shift translated',
  },
}

let instance: I18n

beforeEach(async () => {
  instance = i18next.createInstance()
  await instance.use(initReactI18next).init({
    resources: {
      'builtin:en': { translation: {} },
      'pack:test': { translation: pack },
    },
    lng: 'pack:test',
    fallbackLng: 'builtin:en',
    keySeparator: '.',
    interpolation: { escapeValue: false },
  })
})

function renderTab(props: { lmMode?: boolean } = {}): void {
  render(
    <I18nextProvider i18n={instance}>
      <PopoverTabKey currentKeycode={4} emptyInitial onKeycodeSelect={() => {}} {...props} />
    </I18nextProvider>,
  )
}

function search(query: string): void {
  fireEvent.change(screen.getByTestId('popover-search-input'), { target: { value: query } })
}

describe('PopoverTabKey — translated key descriptions', () => {
  it('finds a key by its translated description and shows it in the detail line', () => {
    renderTab()
    search('hash translated')
    const result = screen.getByTestId('popover-result-KC_NONUS_HASH')
    expect(result).toHaveTextContent('Hash translated')
  })

  it('still finds a key by its English description', () => {
    renderTab()
    search('non-us # and ~')
    expect(screen.getByTestId('popover-result-KC_NONUS_HASH')).toBeInTheDocument()
  })

  it('searches the LM modifier list by translated and English descriptions', () => {
    renderTab({ lmMode: true })
    search('shift translated')
    expect(screen.getByTestId('popover-result-MOD_LSFT')).toHaveTextContent('Shift translated')
    search('left shift')
    expect(screen.getByTestId('popover-result-MOD_LSFT')).toBeInTheDocument()
  })

  it('rebuilds the search index when the language changes', async () => {
    await instance.changeLanguage('builtin:en')
    renderTab()
    search('hash translated')
    expect(screen.queryByTestId('popover-result-KC_NONUS_HASH')).not.toBeInTheDocument()
    await act(async () => { await instance.changeLanguage('pack:test') })
    search('hash translated')
    expect(screen.getByTestId('popover-result-KC_NONUS_HASH')).toBeInTheDocument()
  })
})
