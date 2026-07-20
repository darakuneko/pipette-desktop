// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { KeyLabelMeta } from '../../../shared/types/key-label-store'
import { BUILTIN_QWERTY_LAYOUT_ID } from '../../data/keyboard-layouts'

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

const lookup = {
  ensure: vi.fn().mockResolvedValue(undefined),
  getName: vi.fn().mockReturnValue('Colemak'),
  getMap: vi.fn().mockReturnValue({ KC_E: 'F' }),
  getCompositeLabels: vi.fn().mockReturnValue(undefined),
  getKeymapApplicable: vi.fn().mockReturnValue(false),
}
vi.mock('../../hooks/useKeyLabelLookup', () => ({
  useKeyLabelLookup: () => lookup,
}))

const buildKeymapRewriteTable = vi.fn()
vi.mock('../../../shared/keymap/keymap-apply', async () => {
  const actual = await vi.importActual<typeof import('../../../shared/keymap/keymap-apply')>('../../../shared/keymap/keymap-apply')
  return {
    ...actual,
    buildKeymapRewriteTable: (map: Record<string, string>) => buildKeymapRewriteTable(map),
  }
})

vi.mock('../i18n-packs/LanguagePacksModal', () => ({ LanguagePacksModal: () => null }))
vi.mock('../theme-packs/ThemePacksModal', () => ({ ThemePacksModal: () => null }))
vi.mock('../key-labels/KeyLabelsModal', () => ({ KeyLabelsModal: () => null }))

interface CapturedApplyModalProps {
  open: boolean
  labelName: string
  onApply: () => void
  onDisplayOnly: () => void
  onCancel: () => void
}
let capturedApplyModalProps: CapturedApplyModalProps | null = null
vi.mock('../key-labels/KeymapApplyConfirmModal', () => ({
  KeymapApplyConfirmModal: (props: CapturedApplyModalProps) => {
    capturedApplyModalProps = props
    return null
  },
}))

import { QuickSettingsSelects } from '../QuickSettingsSelects'

describe('QuickSettingsSelects — keyboard layout apply-to-keymap branching', () => {
  const onKeyboardLayoutChange = vi.fn()
  const onApplyKeymapRewrite = vi.fn().mockResolvedValue({ appliedCount: 1 })

  beforeEach(() => {
    vi.clearAllMocks()
    capturedApplyModalProps = null
    lookup.ensure.mockResolvedValue(undefined)
    lookup.getName.mockReturnValue('Colemak')
    lookup.getMap.mockReturnValue({ KC_E: 'F' })
    lookup.getKeymapApplicable.mockReturnValue(false)
  })

  function renderComponent() {
    return render(
      <QuickSettingsSelects
        onThemeChange={vi.fn()}
        keyboardLayout="qwerty"
        onKeyboardLayoutChange={onKeyboardLayoutChange}
        keymapEditable
        onApplyKeymapRewrite={onApplyKeymapRewrite}
      />,
    )
  }

  async function selectColemak() {
    fireEvent.click(screen.getByRole('button', { name: 'keyLabels.title' }))
    await act(async () => {
      fireEvent.mouseDown(screen.getByRole('option', { name: 'Colemak' }))
    })
  }

  it('opens the confirm modal when the flag is set and the table builds', async () => {
    lookup.getKeymapApplicable.mockReturnValue(true)
    buildKeymapRewriteTable.mockReturnValue({ ok: true, table: new Map([['KC_E', 'KC_F']]) })

    renderComponent()
    await selectColemak()

    expect(onKeyboardLayoutChange).not.toHaveBeenCalled()
    expect(capturedApplyModalProps).toMatchObject({ open: true, labelName: 'Colemak' })
  })

  it('switches directly when keymapApplicable is not set', async () => {
    lookup.getKeymapApplicable.mockReturnValue(false)

    renderComponent()
    await selectColemak()

    expect(buildKeymapRewriteTable).not.toHaveBeenCalled()
    expect(onKeyboardLayoutChange).toHaveBeenCalledWith('colemak-id', false)
    expect(capturedApplyModalProps?.open).toBe(false)
  })

  it('switches directly when the flag is set but the table build fails', async () => {
    lookup.getKeymapApplicable.mockReturnValue(true)
    buildKeymapRewriteTable.mockReturnValue({ ok: false, error: 'not a permutation' })

    renderComponent()
    await selectColemak()

    expect(onKeyboardLayoutChange).toHaveBeenCalledWith('colemak-id', false)
    expect(capturedApplyModalProps?.open).toBe(false)
  })

  it('after confirming Rewrite, the select STAYS on the rewritten arrangement and is marked written (Phase K — no more QWERTY reset)', async () => {
    lookup.getKeymapApplicable.mockReturnValue(true)
    buildKeymapRewriteTable.mockReturnValue({ ok: true, table: new Map([['KC_E', 'KC_F']]) })

    renderComponent()
    await selectColemak()
    expect(capturedApplyModalProps?.open).toBe(true)

    await act(async () => { capturedApplyModalProps!.onApply() })

    expect(onApplyKeymapRewrite).toHaveBeenCalledTimes(1)
    const [table] = onApplyKeymapRewrite.mock.calls[0] as [Map<string, string>]
    expect(table).toEqual(new Map([['KC_E', 'KC_F']]))
    // Clean success (appliedCount: 1 > 0) keeps the select on the rewritten
    // arrangement and marks it written — it no longer resets to QWERTY.
    expect(onKeyboardLayoutChange).toHaveBeenCalledWith('colemak-id', true)
    expect(onKeyboardLayoutChange).not.toHaveBeenCalledWith(BUILTIN_QWERTY_LAYOUT_ID, expect.anything())
  })

  it('handleApplyDisplayOnly still switches display straight to the target id, never written', async () => {
    lookup.getKeymapApplicable.mockReturnValue(true)
    buildKeymapRewriteTable.mockReturnValue({ ok: true, table: new Map([['KC_E', 'KC_F']]) })

    renderComponent()
    await selectColemak()

    act(() => { capturedApplyModalProps!.onDisplayOnly() })
    expect(onKeyboardLayoutChange).toHaveBeenCalledWith('colemak-id', false)
    expect(onApplyKeymapRewrite).not.toHaveBeenCalled()
  })

  it('switches directly without fetching the map when the keymap is not editable', async () => {
    render(
      <QuickSettingsSelects
        onThemeChange={vi.fn()}
        keyboardLayout="qwerty"
        onKeyboardLayoutChange={onKeyboardLayoutChange}
        keymapEditable={false}
        onApplyKeymapRewrite={onApplyKeymapRewrite}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'keyLabels.title' }))
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Colemak' }))

    expect(lookup.ensure).not.toHaveBeenCalled()
    expect(onKeyboardLayoutChange).toHaveBeenCalledWith('colemak-id', false)
  })

  // --- Phase K: select trigger visualization ---

  describe('keymapWritten trigger label (Plan-qwerty-select-no-rewrite Phase K)', () => {
    it('shows the written-suffix trigger label when keymapWritten is true', () => {
      render(
        <QuickSettingsSelects
          onThemeChange={vi.fn()}
          keyboardLayout="colemak-id"
          keymapWritten
          onKeyboardLayoutChange={onKeyboardLayoutChange}
          keymapEditable
          onApplyKeymapRewrite={onApplyKeymapRewrite}
        />,
      )
      // This suite's t() mock returns the key itself rather than the real
      // suffix text — UpwardSelect appends whatever this resolves to onto
      // its own resolved option name, so the trigger text still contains
      // this key string as a substring.
      expect(screen.getByRole('button', { name: 'keyLabels.title' })).toHaveTextContent('keyLabels.select.writtenSuffix')
    })

    it('shows the plain pack name (no suffix) when keymapWritten is false', () => {
      renderComponent()
      expect(screen.getByRole('button', { name: 'keyLabels.title' })).not.toHaveTextContent('keyLabels.select.writtenSuffix')
    })
  })
})
