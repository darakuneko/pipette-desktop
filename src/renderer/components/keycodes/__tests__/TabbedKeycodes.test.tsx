// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const mockBasicKeycodes = [
  { qmkId: 'KC_A', label: 'A', hidden: false },
  { qmkId: 'KC_B', label: 'B', hidden: false },
  { qmkId: 'KC_TILD', label: '~', hidden: false },
]

const mockBehaviorKeycodes = [
  { qmkId: 'QK_BOOT', label: 'Boot', hidden: false },
]

const mockSystemKeycodes = [
  { qmkId: 'KC_MUTE', label: 'Mute', hidden: false },
  { qmkId: 'KC_MS_U', label: 'Mouse Up', hidden: false },
]

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'keycodes.basic': 'Basic',
        'keycodes.behavior': 'Behavior',
        'keycodes.system': 'System',
      }
      return map[key] ?? key
    },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}))

vi.mock('../categories', () => ({
  KEYCODE_CATEGORIES: [
    { id: 'basic', labelKey: 'keycodes.basic', getKeycodes: () => mockBasicKeycodes },
    { id: 'behavior', labelKey: 'keycodes.behavior', getKeycodes: () => mockBehaviorKeycodes },
    { id: 'system', labelKey: 'keycodes.system', getKeycodes: () => mockSystemKeycodes },
  ],
}))

vi.mock('../../../i18n', () => ({
  default: { changeLanguage: vi.fn() },
}))

vi.mock('../../../hooks/useAppConfig', () => ({
  useAppConfig: () => ({ config: { defaultBasicViewType: 'list', defaultSplitKeyMode: 'split' }, loading: false, set: vi.fn() }),
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  keycodeTooltip: (qmkId: string) => qmkId,
  getKeycodeRevision: () => 0,
  isBasic: (qmkId: string) => {
    // KC_TILD = 0x235 (> 0xFF), QK_BOOT = 0x7C00 (> 0xFF)
    const nonBasic = new Set(['KC_TILD', 'QK_BOOT'])
    return !nonBasic.has(qmkId)
  },
  getAvailableLMMods: () => [],
  findKeycode: () => undefined,
  deserialize: () => 0,
  KEYCODES_SPECIAL: [],
  KEYCODES_BASIC: [],
  KEYCODES_SHIFTED: [],
  KEYCODES_ISO: [],
}))

import { TabbedKeycodes } from '../TabbedKeycodes'

describe('TabbedKeycodes', () => {
  it('renders category tabs', () => {
    render(<TabbedKeycodes />)
    expect(screen.getByText('Basic')).toBeInTheDocument()
    expect(screen.getByText('Behavior')).toBeInTheDocument()
  })

  it('shows keycodes from active category (default: basic)', () => {
    render(<TabbedKeycodes />)
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
  })

  it('switches category on tab click', () => {
    render(<TabbedKeycodes />)
    fireEvent.click(screen.getByText('Behavior'))
    expect(screen.getByText('Boot')).toBeInTheDocument()
    // Basic tab content is still in the DOM but hidden via invisible class
    expect(screen.getByText('A').closest('[class*="invisible"]')).toBeTruthy()
  })

  it('calls onKeycodeSelect when keycode clicked', () => {
    const onSelect = vi.fn()
    render(<TabbedKeycodes onKeycodeSelect={onSelect} />)
    fireEvent.click(screen.getByText('A'))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ qmkId: 'KC_A' }))
  })

  it('shows categories with basic keycodes when maskOnly is true', () => {
    render(<TabbedKeycodes maskOnly />)
    // Basic and System contain keycodes < 0xFF
    expect(screen.getByText('Basic')).toBeInTheDocument()
    expect(screen.getByText('System')).toBeInTheDocument()
    // Behavior has only QK_BOOT (> 0xFF)
    expect(screen.queryByText('Behavior')).not.toBeInTheDocument()
  })

  it('filters out non-basic keycodes within category when maskOnly', () => {
    render(<TabbedKeycodes maskOnly />)
    // KC_A and KC_B are basic (< 0xFF), KC_TILD is not (0x235)
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
    expect(screen.queryByText('~')).not.toBeInTheDocument()
  })

  it('applies active style to selected tab', () => {
    render(<TabbedKeycodes />)
    expect(screen.getByText('Basic').className).toContain('text-accent')
  })

  it('calls onBackgroundClick when clicking on grid background', () => {
    const onBg = vi.fn()
    const { container } = render(<TabbedKeycodes onBackgroundClick={onBg} />)
    // The outer container (has onClick={handleBackgroundClick})
    const grid = container.querySelector('.bg-picker-bg')!
    // Click directly on the grid background (not on a button)
    fireEvent.click(grid)
    expect(onBg).toHaveBeenCalledTimes(1)
  })

  it('does NOT call onBackgroundClick when clicking a keycode button', () => {
    const onBg = vi.fn()
    render(<TabbedKeycodes onBackgroundClick={onBg} />)
    fireEvent.click(screen.getByText('A'))
    expect(onBg).not.toHaveBeenCalled()
  })

  it('passes highlighted prop to matching keycodes', () => {
    const highlighted = new Set(['KC_A'])
    render(<TabbedKeycodes highlightedKeycodes={highlighted} />)
    const btnA = screen.getByText('A').closest('button')!
    const btnB = screen.getByText('B').closest('button')!
    expect(btnA.className).toContain('text-accent')
    expect(btnB.className).not.toContain('text-accent')
  })

  it('Enter on a focused picker button is preventDefaulted even without onConfirm (no duplicate insert)', () => {
    render(<TabbedKeycodes onKeycodeSelect={vi.fn()} />)
    const btn = screen.getByText('A').closest('button')!
    btn.focus()
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    window.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('Enter on a focused picker button calls onConfirm when provided', () => {
    const onConfirm = vi.fn()
    render(<TabbedKeycodes onKeycodeSelect={vi.fn()} onConfirm={onConfirm} />)
    const btn = screen.getByText('A').closest('button')!
    btn.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
