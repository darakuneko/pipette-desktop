// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'editor.keymap.keyPopover.keyTab': 'Key',
        'editor.keymap.keyPopover.codeTab': 'Code',
        'editor.keymap.keyPopover.searchPlaceholder': 'Search keycodes...',
        'editor.keymap.keyPopover.noResults': 'No keycodes found',
        'editor.keymap.keyPopover.hexLabel': 'HexCode',
        'editor.keymap.keyPopover.hexManual': 'Manually assign keycode in hex',
        'editor.keymap.keyPopover.qmkLabel': `KeyCode: ${opts?.value ?? ''}`,
        'common.apply': 'Apply',
      }
      return map[key] ?? key
    },
  }),
}))

const mockKeycodes = [
  { qmkId: 'KC_TRNS', label: '\u25BD', tooltip: undefined, hidden: false, alias: ['KC_TRNS', 'KC_TRANSPARENT'], masked: false },
  { qmkId: 'KC_A', label: 'A', tooltip: 'a', hidden: false, alias: ['KC_A'], masked: false },
  { qmkId: 'KC_B', label: 'B', tooltip: 'b', hidden: false, alias: ['KC_B'], masked: false },
  { qmkId: 'KC_ENTER', label: 'Enter', tooltip: 'Return', hidden: false, alias: ['KC_ENTER', 'KC_ENT'], masked: false },
  { qmkId: 'KC_SPACE', label: 'Space', tooltip: 'space', hidden: false, alias: ['KC_SPACE', 'KC_SPC'], masked: false },
]

const mockLayerKeycodes = [
  { qmkId: 'MO(1)', label: 'MO(1)', hidden: false, alias: ['MO(1)'], masked: false },
]

vi.mock('../categories', () => ({
  KEYCODE_CATEGORIES: [
    { id: 'basic', labelKey: 'keycodes.basic', getKeycodes: () => mockKeycodes },
    { id: 'layers', labelKey: 'keycodes.layers', getKeycodes: () => mockLayerKeycodes },
  ],
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => {
    if (code === 4) return 'KC_A'
    if (code === 5) return 'KC_B'
    if (code === 0x2c) return 'KC_SPACE'
    // LT0(KC_A) = 0x5104
    if (code === 0x5104) return 'LT0(KC_A)'
    // LT0(KC_SPACE) = 0x512c
    if (code === 0x512c) return 'LT0(KC_SPACE)'
    // LT0(KC_B) = 0x5105
    if (code === 0x5105) return 'LT0(KC_B)'
    // LSFT(KC_A) = 0x0204 — masked keycode without underscore in prefix
    if (code === 0x0204) return 'LSFT(KC_A)'
    // C_S_T(KC_A) = 0x2304 — masked keycode with underscores in prefix
    if (code === 0x2304) return 'C_S_T(KC_A)'
    return `0x${code.toString(16).padStart(4, '0')}`
  },
  deserialize: (val: string) => {
    if (val === 'KC_A') return 4
    if (val === 'KC_B') return 5
    if (val === 'KC_SPACE') return 0x2c
    return 0
  },
  isMask: (qmkId: string) => /^[A-Z][A-Z0-9_]*\(/.test(qmkId),
  // MO(1) is not basic (layer keycode > 0xFF)
  isBasic: (qmkId: string) => !/^[A-Z][A-Z0-9_]*\(/.test(qmkId),
  findOuterKeycode: (qmkId: string) => mockKeycodes.find((kc) => kc.qmkId === qmkId),
  findInnerKeycode: (qmkId: string) => {
    // Extract inner keycode from e.g. "LT0(KC_A)" -> "KC_A"
    const match = /\(([^)]+)\)/.exec(qmkId)
    if (match) {
      return mockKeycodes.find((kc) => kc.qmkId === match[1])
    }
    return mockKeycodes.find((kc) => kc.qmkId === qmkId)
  },
  isLMKeycode: () => false,
  resolve: (name: string) => {
    if (name === 'QMK_LM_MASK') return 0x1f
    return 0
  },
  getAvailableLMMods: () => [],
  getKeycodeRevision: () => 0,
}))

import { KeyPopover } from '../KeyPopover'

function makeAnchorRect(): DOMRect {
  return {
    top: 100,
    left: 200,
    bottom: 140,
    right: 260,
    width: 60,
    height: 40,
    x: 200,
    y: 100,
    toJSON: () => ({}),
  }
}

const onKeycodeSelect = vi.fn()
const onRawKeycodeSelect = vi.fn()
const onClose = vi.fn()

const defaultProps = {
  anchorRect: makeAnchorRect(),
  currentKeycode: 4,
  onKeycodeSelect,
  onRawKeycodeSelect,
  onClose,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('KeyPopover', () => {
  it('renders with two tabs (Key and Code)', () => {
    render(<KeyPopover {...defaultProps} />)
    expect(screen.getByTestId('popover-tab-key')).toBeInTheDocument()
    expect(screen.getByTestId('popover-tab-code')).toBeInTheDocument()
  })

  it('shows Key tab by default with search input prefilled (prefix stripped)', () => {
    render(<KeyPopover {...defaultProps} />)
    const input = screen.getByTestId('popover-search-input') as HTMLInputElement
    expect(input).toBeInTheDocument()
    expect(input.value).toBe('A')
  })

  it('switches to Code tab', () => {
    render(<KeyPopover {...defaultProps} />)
    fireEvent.click(screen.getByTestId('popover-tab-code'))
    expect(screen.getByTestId('popover-hex-input')).toBeInTheDocument()
  })

  it('closes on Escape key', () => {
    render(<KeyPopover {...defaultProps} />)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on outside click', async () => {
    render(
      <div>
        <div data-testid="outside">outside</div>
        <KeyPopover {...defaultProps} />
      </div>,
    )
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    act(() => {
      fireEvent.mouseDown(screen.getByTestId('outside'))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does NOT close when clicking inside the popover', async () => {
    render(<KeyPopover {...defaultProps} />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    const popover = screen.getByTestId('key-popover')
    fireEvent.mouseDown(popover)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('PopoverTabKey — search', () => {
  function renderAndSearch(query?: string): void {
    render(<KeyPopover {...defaultProps} />)
    if (query !== undefined) {
      fireEvent.change(screen.getByTestId('popover-search-input'), {
        target: { value: query },
      })
    }
  }

  it('prefills search with current keycode (prefix stripped) and shows matching results', () => {
    renderAndSearch()
    const input = screen.getByTestId('popover-search-input') as HTMLInputElement
    expect(input.value).toBe('A')
    expect(screen.getByTestId('popover-result-KC_A')).toBeInTheDocument()
  })

  it('filters keycodes by search query', () => {
    renderAndSearch('enter')
    expect(screen.getByTestId('popover-result-KC_ENTER')).toBeInTheDocument()
    expect(screen.queryByTestId('popover-result-KC_A')).not.toBeInTheDocument()
  })

  it('shows no results message for unmatched query', () => {
    renderAndSearch('zzzzz')
    expect(screen.getByText('No keycodes found')).toBeInTheDocument()
  })

  it('calls onKeycodeSelect and closes when result is clicked', () => {
    renderAndSearch('A')
    fireEvent.click(screen.getByTestId('popover-result-KC_A'))
    expect(onKeycodeSelect).toHaveBeenCalledWith(expect.objectContaining({ qmkId: 'KC_A' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('matches stripped alias — "ent" finds KC_ENTER via KC_ENT alias', () => {
    renderAndSearch('ent')
    expect(screen.getByTestId('popover-result-KC_ENTER')).toBeInTheDocument()
  })

  it('shows detail with qmkId, tooltip, and aliases', () => {
    renderAndSearch('enter')
    const result = screen.getByTestId('popover-result-KC_ENTER')
    expect(result).toHaveTextContent('KC_ENTER')
    expect(result).toHaveTextContent('Return')
    expect(result).toHaveTextContent('KC_ENT')
  })

  it('does not match by prefix — "KC_" alone does not find KC_A', () => {
    renderAndSearch('KC_')
    expect(screen.queryByTestId('popover-result-KC_A')).not.toBeInTheDocument()
  })

  it('ranks exact matches first — "a" shows KC_A before KC_TRNS', () => {
    renderAndSearch('a')
    const results = screen.getAllByTestId(/^popover-result-/)
    expect(results[0]).toHaveAttribute('data-testid', 'popover-result-KC_A')
  })
})

describe('PopoverTabCode — hex input', () => {
  function renderCodeTab(hexValue?: string): void {
    render(<KeyPopover {...defaultProps} />)
    fireEvent.click(screen.getByTestId('popover-tab-code'))
    if (hexValue !== undefined) {
      fireEvent.change(screen.getByTestId('popover-hex-input'), {
        target: { value: hexValue },
      })
    }
  }

  it('prefills hex input with current keycode', () => {
    renderCodeTab()
    const input = screen.getByTestId('popover-hex-input') as HTMLInputElement
    expect(input.value).toBe('0004')
  })

  it('shows keycode label for valid hex input', () => {
    renderCodeTab('0005')
    expect(screen.getByText('KeyCode: KC_B')).toBeInTheDocument()
  })

  it('calls onRawKeycodeSelect and closes when apply is clicked', () => {
    renderCodeTab('0005')
    fireEvent.click(screen.getByTestId('popover-code-apply'))
    expect(onRawKeycodeSelect).toHaveBeenCalledWith(5)
    expect(onClose).toHaveBeenCalled()
  })

  it('disables apply button when value equals current keycode', () => {
    renderCodeTab()
    expect(screen.getByTestId('popover-code-apply')).toBeDisabled()
  })

  it('does not apply when pressing Enter with unchanged value', () => {
    renderCodeTab()
    fireEvent.keyDown(screen.getByTestId('popover-hex-input'), { key: 'Enter' })
    expect(onRawKeycodeSelect).not.toHaveBeenCalled()
  })

  it('disables apply button when hex has no matching keycode', () => {
    renderCodeTab('FFFF')
    expect(screen.getByTestId('popover-code-apply')).toBeDisabled()
  })
})

describe('KeyPopover — maskOnly mode', () => {
  // LT0(KC_A) = 0x5104
  const maskedProps = {
    ...defaultProps,
    currentKeycode: 0x5104,
    maskOnly: true,
  }

  it('prefills search with inner keycode stripped prefix when maskOnly', () => {
    render(<KeyPopover {...maskedProps} />)
    const input = screen.getByTestId('popover-search-input') as HTMLInputElement
    // LT0(KC_A) -> findInnerKeycode -> KC_A -> stripPrefix -> "A"
    expect(input.value).toBe('A')
  })

  it('shows only basic category keycodes in search results when maskOnly', () => {
    render(<KeyPopover {...maskedProps} />)
    fireEvent.change(screen.getByTestId('popover-search-input'), {
      target: { value: 'MO' },
    })
    // Layer keycodes should not appear in maskOnly mode
    expect(screen.queryByTestId('popover-result-MO(1)')).not.toBeInTheDocument()
  })

  it('shows inner byte only in Code tab when maskOnly', () => {
    render(<KeyPopover {...maskedProps} />)
    fireEvent.click(screen.getByTestId('popover-tab-code'))
    const input = screen.getByTestId('popover-hex-input') as HTMLInputElement
    // 0x5104 & 0x00FF = 0x04 -> "04"
    expect(input.value).toBe('04')
  })

  it('applies full code with mask preserved in Code tab when maskOnly', () => {
    render(<KeyPopover {...maskedProps} />)
    fireEvent.click(screen.getByTestId('popover-tab-code'))
    // Change inner byte from 04 (KC_A) to 2C (KC_SPACE)
    fireEvent.change(screen.getByTestId('popover-hex-input'), {
      target: { value: '2C' },
    })
    fireEvent.click(screen.getByTestId('popover-code-apply'))
    // Should apply full code: 0x5100 | 0x2C = 0x512C (LT0(KC_SPACE))
    expect(onRawKeycodeSelect).toHaveBeenCalledWith(0x512c)
    expect(onClose).toHaveBeenCalled()
  })

  it('rejects hex input exceeding 2 digits in maskOnly Code tab', () => {
    render(<KeyPopover {...maskedProps} />)
    fireEvent.click(screen.getByTestId('popover-tab-code'))
    fireEvent.change(screen.getByTestId('popover-hex-input'), {
      target: { value: '0005' },
    })
    // 4-digit input is invalid in maskOnly mode (max 2 digits)
    expect(screen.getByTestId('popover-code-apply')).toBeDisabled()
  })

  it('handles lowercase hex input in maskOnly Code tab', () => {
    render(<KeyPopover {...maskedProps} />)
    fireEvent.click(screen.getByTestId('popover-tab-code'))
    fireEvent.change(screen.getByTestId('popover-hex-input'), {
      target: { value: '2c' },
    })
    fireEvent.click(screen.getByTestId('popover-code-apply'))
    expect(onRawKeycodeSelect).toHaveBeenCalledWith(0x512c)
  })
})

describe('KeyPopover — masked keycode without underscore prefix', () => {
  // LSFT(KC_A) = 0x0204 — has no underscore before '('
  const lsftProps = {
    ...defaultProps,
    currentKeycode: 0x0204,
  }

  it('prefills search with outer keycode name, not broken suffix', () => {
    render(<KeyPopover {...lsftProps} />)
    const input = screen.getByTestId('popover-search-input') as HTMLInputElement
    // Should show "LSFT" (outer name), NOT "A)" (broken stripPrefix result)
    expect(input.value).toBe('LSFT')
  })

  it('prefills search with outer name for LT0 masked keycode (non-maskOnly)', () => {
    render(<KeyPopover {...defaultProps} currentKeycode={0x5104} />)
    const input = screen.getByTestId('popover-search-input') as HTMLInputElement
    // LT0(KC_A) in non-maskOnly: should show "LT0"
    expect(input.value).toBe('LT0')
  })

  it('prefills search with outer name for masked keycode with underscores in prefix', () => {
    render(<KeyPopover {...defaultProps} currentKeycode={0x2304} />)
    const input = screen.getByTestId('popover-search-input') as HTMLInputElement
    // C_S_T(KC_A) in non-maskOnly: should show "C_S_T"
    expect(input.value).toBe('C_S_T')
  })
})
