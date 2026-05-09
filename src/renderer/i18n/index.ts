// SPDX-License-Identifier: GPL-2.0-or-later

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import english from './locales/english.json'

const { name: _name, version: _version, ...englishTranslations } = english as Record<string, unknown>

export const SUPPORTED_LANGUAGES = [
  { id: 'builtin:en', name: 'English' },
] as const

i18n.use(initReactI18next).init({
  resources: {
    'builtin:en': { translation: englishTranslations },
  },
  lng: 'builtin:en',
  fallbackLng: 'builtin:en',
  keySeparator: '.',
  interpolation: {
    escapeValue: false,
  },
})

export default i18n
