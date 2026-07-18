// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { KeyLabelMeta } from '../../../shared/types/key-label-store'
import type { KeymapRewriteLayoutIds } from '../../../shared/keymap/keymap-apply'

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

// composeRewriteTables is real (not mocked) so this suite also exercises
// the appliedKeymapLayout-aware composition wiring, not just the
// single-table branch — the composition math itself has its own dedicated
// coverage in shared/keymap/__tests__/keymap-apply.test.ts.
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
    expect(onKeyboardLayoutChange).toHaveBeenCalledWith('colemak-id')
    expect(capturedApplyModalProps?.open).toBe(false)
  })

  it('switches directly when the flag is set but the table build fails', async () => {
    lookup.getKeymapApplicable.mockReturnValue(true)
    buildKeymapRewriteTable.mockReturnValue({ ok: false, error: 'not a permutation' })

    renderComponent()
    await selectColemak()

    expect(onKeyboardLayoutChange).toHaveBeenCalledWith('colemak-id')
    expect(capturedApplyModalProps?.open).toBe(false)
  })

  it('after confirming Rewrite, switches display to qwerty (not the target) — display double-remap fix', async () => {
    lookup.getKeymapApplicable.mockReturnValue(true)
    buildKeymapRewriteTable.mockReturnValue({ ok: true, table: new Map([['KC_E', 'KC_F']]) })

    renderComponent()
    await selectColemak()
    expect(capturedApplyModalProps?.open).toBe(true)

    await act(async () => { capturedApplyModalProps!.onApply() })

    expect(onApplyKeymapRewrite).toHaveBeenCalledTimes(1)
    const [, layoutIds] = onApplyKeymapRewrite.mock.calls[0] as [unknown, KeymapRewriteLayoutIds]
    // No appliedKeymapLayout prop was passed to QuickSettingsSelects, so
    // "before" defaults to the built-in QWERTY id.
    expect(layoutIds).toEqual({ before: 'qwerty', after: 'colemak-id' })
    // The keymap now holds Colemak's keycodes directly — display must stay
    // on QWERTY labels, not switch to 'colemak-id' (which would re-translate
    // them and look double-applied).
    expect(onKeyboardLayoutChange).toHaveBeenCalledWith('qwerty')
    expect(onKeyboardLayoutChange).not.toHaveBeenCalledWith('colemak-id')
  })

  it('handleApplyDisplayOnly still switches display straight to the target id', async () => {
    lookup.getKeymapApplicable.mockReturnValue(true)
    buildKeymapRewriteTable.mockReturnValue({ ok: true, table: new Map([['KC_E', 'KC_F']]) })

    renderComponent()
    await selectColemak()

    act(() => { capturedApplyModalProps!.onDisplayOnly() })
    expect(onKeyboardLayoutChange).toHaveBeenCalledWith('colemak-id')
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
    expect(onKeyboardLayoutChange).toHaveBeenCalledWith('colemak-id')
  })
})
