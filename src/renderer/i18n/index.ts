// SPDX-License-Identifier: GPL-2.0-or-later

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import ja from './locales/ja.json'

export const SUPPORTED_LANGUAGES = [
  { id: 'en', name: 'English' },
  { id: 'ja', name: '日本語' },
] as const

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ja: { translation: ja },
  },
  lng: undefined,
  fallbackLng: 'en',
  keySeparator: '.',
  interpolation: {
    escapeValue: false,
  },
})

export default i18n
