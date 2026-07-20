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

// Entry-file registry backing the "Write"/"View" tag on the Keyboard
// Layout select's options — mirrors the fake `useKeyLabelLookup` in
// KeyLabelsModal.test.tsx so this suite reuses the same predicate
// contract (`keymapApplicable && buildKeymapRewriteTable(map).ok`)
// without round-tripping through the real IPC-backed cache. Empty by
// default: a pack with no seeded entry is "not yet resolved" and gets
// no tag, matching production behavior before `ensure()`'s fetch lands.
const keyLabelRegistry = new Map<string, { map: Record<string, string>; keymapApplicable: boolean }>()

vi.mock('../../hooks/useKeyLabelLookup', () => ({
  useKeyLabelLookup: () => ({
    ensure: vi.fn(async () => {}),
    getName: vi.fn((id: string) => id),
    getMap: vi.fn((id: string) => keyLabelRegistry.get(id)?.map),
    getCompositeLabels: vi.fn(() => undefined),
    getKeymapApplicable: vi.fn((id: string) => keyLabelRegistry.get(id)?.keymapApplicable === true),
  }),
}))

vi.mock('../i18n-packs/LanguagePacksModal', () => ({ LanguagePacksModal: () => null }))
vi.mock('../theme-packs/ThemePacksModal', () => ({ ThemePacksModal: () => null }))
vi.mock('../key-labels/KeyLabelsModal', () => ({ KeyLabelsModal: () => null }))

import { QuickSettingsSelects } from '../QuickSettingsSelects'

describe('QuickSettingsSelects — Keyboard Layout select passthrough (Plan-qwerty-select-no-rewrite v7)', () => {
  const onKeyboardLayoutChange = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    keyLabelRegistry.clear()
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

  describe('Keyboard Layout select — per-pack Write/View tag', () => {
    function findOption(startingWith: string) {
      return screen.getAllByRole('option').find((o) => o.textContent?.startsWith(startingWith))
    }

    it('shows the short Write tag for a pack whose map builds a clean rewrite permutation', () => {
      keyLabelRegistry.set('colemak-id', { map: { KC_A: 'b', KC_B: 'a' }, keymapApplicable: true })
      renderComponent()
      fireEvent.click(screen.getByRole('button', { name: 'keyLabels.title' }))
      expect(findOption('Colemak')?.textContent).toBe('Colemak' + 'keyLabels.typeKeymapWriteShort')
    })

    it('shows the short View tag for a resolved pack that is not keymap-writable', () => {
      keyLabelRegistry.set('colemak-id', { map: { KC_A: 'b' }, keymapApplicable: false })
      renderComponent()
      fireEvent.click(screen.getByRole('button', { name: 'keyLabels.title' }))
      expect(findOption('Colemak')?.textContent).toBe('Colemak' + 'keyLabels.typeViewOnlyShort')
    })

    it('shows no tag for a pack whose entry has not resolved yet — avoids flashing a wrong tag before ensure() lands', () => {
      renderComponent()
      fireEvent.click(screen.getByRole('button', { name: 'keyLabels.title' }))
      expect(findOption('Colemak')?.textContent).toBe('Colemak')
    })

    it('shows no tag for the built-in QWERTY option, even when the store somehow reports it writable', () => {
      keyLabelRegistry.set('qwerty', { map: { KC_A: 'b', KC_B: 'a' }, keymapApplicable: true })
      renderComponent()
      fireEvent.click(screen.getByRole('button', { name: 'keyLabels.title' }))
      // The option's display name is overridden by `useLayoutOptions` to
      // the shared `keyLabels.qwertyDefaultName` string (same key the
      // simulation tab's "QWERTY (Default)" pane uses) rather than the
      // raw stored "QWERTY" — under the identity `t` mock that renders
      // literally as the key itself.
      expect(findOption('keyLabels.qwertyDefaultName')?.textContent).toBe('keyLabels.qwertyDefaultName')
    })
  })
})
