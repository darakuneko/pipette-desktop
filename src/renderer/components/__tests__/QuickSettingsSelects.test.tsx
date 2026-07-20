// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// Plan-qwerty-select-no-rewrite v7: the Rewrite confirm modal and its
// lookup/validation live in `useKeymapApplyPrompt`, lifted to App.tsx now
// that the Apply button is on KeymapEditor's simulation tab — see
// `useKeymapApplyPrompt.test.ts` for that coverage. This component's own
// contract shrank to a plain passthrough: the Keyboard Layout select's
// onChange is called with the raw selection, nothing more.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { KeyLabelMeta } from '../../../shared/types/key-label-store'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'builtin:en', changeLanguage: vi.fn() },
  }),
}))

vi.mock('../../hooks/useAppConfig', () => ({
  useAppConfig: () => ({
    config: { language: 'builtin:en', theme: 'system' },
    set: vi.fn(),
  }),
}))

vi.mock('../../hooks/useI18nPackStore', () => ({
  useI18nPackStore: () => ({ metas: [] }),
}))

vi.mock('../../hooks/useThemePackStore', () => ({
  useThemePackStore: () => ({ metas: [] }),
}))

// Real useLanguageOptions pulls in renderer/i18n/index.ts, which calls
// i18n.use(initReactI18next).init(...) at module load — irrelevant here
// and not worth also mocking react-i18next's initReactI18next export for.
vi.mock('../../hooks/useLanguageOptions', () => ({
  useLanguageOptions: () => [{ id: 'builtin:en', name: 'English' }],
}))

const KEY_LABEL_META: KeyLabelMeta = {
  id: 'colemak-id',
  name: 'Colemak',
  filename: 'colemak.json',
  savedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

vi.mock('../../hooks/useKeyLabels', () => ({
  useKeyLabels: () => ({ metas: [KEY_LABEL_META] }),
}))

vi.mock('../i18n-packs/LanguagePacksModal', () => ({ LanguagePacksModal: () => null }))
vi.mock('../theme-packs/ThemePacksModal', () => ({ ThemePacksModal: () => null }))
vi.mock('../key-labels/KeyLabelsModal', () => ({ KeyLabelsModal: () => null }))

import { QuickSettingsSelects } from '../QuickSettingsSelects'

describe('QuickSettingsSelects — Keyboard Layout select passthrough (Plan-qwerty-select-no-rewrite v7)', () => {
  const onKeyboardLayoutChange = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  function renderComponent() {
    return render(
      <QuickSettingsSelects
        onThemeChange={vi.fn()}
        keyboardLayout="qwerty"
        onKeyboardLayoutChange={onKeyboardLayoutChange}
      />,
    )
  }

  it('calls onKeyboardLayoutChange with the raw selection — no modal, no lookup', async () => {
    renderComponent()
    fireEvent.click(screen.getByRole('button', { name: 'keyLabels.title' }))
    await act(async () => {
      fireEvent.mouseDown(screen.getByRole('option', { name: 'Colemak' }))
    })
    expect(onKeyboardLayoutChange).toHaveBeenCalledWith('colemak-id')
  })

  it('does not render the select at all when the layout/onChange props are absent', () => {
    render(<QuickSettingsSelects onThemeChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'keyLabels.title' })).toBeNull()
  })
})
