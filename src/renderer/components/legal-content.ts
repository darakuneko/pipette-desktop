// SPDX-License-Identifier: GPL-2.0-or-later

interface LegalSection {
  title: string
  paragraphs: string[]
}

export const LEGAL_SECTIONS: LegalSection[] = [
  {
    title: 'Legal Information',
    paragraphs: [
      'Pipette is open-source software distributed under the GPL-3.0-or-later license.',
      'Pipette communicates with connected keyboards via USB HID. Keymap changes are written directly to the keyboard\u2019s firmware.',
      'Pipette stores application settings and saved keymaps locally. This data remains on your device unless you explicitly enable sync or upload to Pipette Hub.',
    ],
  },
  {
    title: 'Google Drive Integration',
    paragraphs: [
      'If synchronization is enabled, Pipette uses Google Drive appDataFolder to store encrypted sync data. The appDataFolder is not regular Google Drive storage \u2014 it is a hidden, app-specific folder that only Pipette can access. Your personal Drive files are never touched.',
    ],
  },
  {
    title: 'Pipette Hub Service',
    paragraphs: [
      'Data uploaded to Pipette Hub is subject to Pipette Hub\u2019s Terms of Service. Uploaded content (keymaps, thumbnails, metadata) is stored on Pipette Hub\u2019s servers and may be publicly visible.',
    ],
  },
  {
    title: 'Disclaimer',
    paragraphs: [
      'Pipette is provided as-is, without warranty of any kind. Use of the software is at your own risk.',
    ],
  },
]
