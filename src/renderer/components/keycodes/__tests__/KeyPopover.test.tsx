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
        'editor.keymap.keyPopover.modMask': 'Mod Mask',
        'editor.keymap.keyPopover.modTap': 'Mod-Tap',
        'editor.keymap.keyPopover.lt': 'LT',
        'editor.keymap.keyPopover.shT': 'SH_T',
        'editor.keymap.keyPopover.lm': 'LM',
        'editor.keymap.keyPopover.layerLabel': 'Layer',
        'editor.keymap.keyPopover.keySelected': `Selected: ${opts?.key ?? ''}`,
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

const mockLMMods = [
  { qmkId: 'MOD_LSFT', label: 'LSft', tooltip: 'Left Shift', hidden: false, alias: ['MOD_LSFT'], masked: false },
  { qmkId: 'MOD_LCTL', label: 'LCtl', tooltip: 'Left Control', hidden: false, alias: ['MOD_LCTL'], masked: false },
]

vi.mock('../categories', () => ({
  KEYCODE_CATEGORIES: [
    { id: 'basic', labelKey: 'keycodes.basic', getKeycodes: () => mockKeycodes },
    { id: 'layers', labelKey: 'keycodes.layers', getKeycodes: () => mockLayerKeycodes },
  ],
}))

const allMockKeycodes = [...mockKeycodes, ...mockLMMods]

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => {
    if (code === 4) return 'KC_A'
    if (code === 5) return 'KC_B'
    if (code === 0x2c) return 'KC_SPACE'
    // LT keycodes in the actual LT range (0x4000-0x4FFF)
    if (code === 0x4004) return 'LT0(KC_A)'
    if (code === 0x4104) return 'LT1(KC_A)'
    if (code === 0x4204) return 'LT2(KC_A)'
    // LT keycodes used in maskOnly tests (legacy range, not in isLTKeycode range)
    if (code === 0x5104) return 'LT0(KC_A)'
    if (code === 0x512c) return 'LT0(KC_SPACE)'
    if (code === 0x5105) return 'LT0(KC_B)'
    // SH_T keycodes
    if (code === 0x5604) return 'SH_T(KC_A)'
    // LSFT(KC_A) = 0x0204 — masked keycode without underscore in prefix
    if (code === 0x0204) return 'LSFT(KC_A)'
    // C_S_T(KC_A) = 0x2304 — masked keycode with underscores in prefix
    if (code === 0x2304) return 'C_S_T(KC_A)'
    // LM0 with mod=0 (empty inner)
    if (code === 0x7000) return 'LM0(0x0)'
    // LM0 with MOD_LSFT
    if (code === 0x7002) return 'LM0(MOD_LSFT)'
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
      return allMockKeycodes.find((kc) => kc.qmkId === match[1])
    }
    return mockKeycodes.find((kc) => kc.qmkId === qmkId)
  },
  isLMKeycode: (code: number) => code >= 0x7000 && code <= 0x70ff,
  isLTKeycode: (code: number) => code >= 0x4000 && code < 0x5000,
  isSHTKeycode: (code: number) => code >= 0x5600 && code <= 0x56ef,
  extractLTLayer: (code: number) => (code >> 8) & 0x0f,
  extractLMLayer: (code: number) => (code >> 4) & 0x0f,
  extractLMMod: (code: number) => code & 0x1f,
  buildLTKeycode: (layer: number, basicKey: number) => 0x4000 | ((layer & 0x0f) << 8) | (basicKey & 0xff),
  buildSHTKeycode: (basicKey: number) => 0x5600 | (basicKey & 0xff),
  buildLMKeycode: (layer: number, mod: number) => 0x7000 | ((layer & 0x0f) << 4) | (mod & 0x1f),
  resolve: (name: string) => {
    if (name === 'QMK_LM_MASK') return 0x1f
    if (name === 'QK_LAYER_TAP') return 0x4000
    if (name === 'SH_T(kc)') return 0x5600
    if (name === 'KC_A') return 4
    if (name === 'KC_B') return 5
    if (name === 'KC_SPACE') return 0x2c
    if (name === 'KC_ENTER') return 0x28
    if (name === 'MOD_LSFT') return 0x02
    if (name === 'MOD_LCTL') return 0x01
    return 0
  },
  getAvailableLMMods: () => mockLMMods,
  getKeycodeRevision: () => 0,
  isModMaskKeycode: (code: number) => code >= 0x0100 && code <= 0x1fff,
  isModTapKeycode: (code: number) => code >= 0x6000 && code < 0x8000,
  extractModMask: (code: number) => (code >> 8) & 0x1f,
  extractBasicKey: (code: number) => code & 0xff,
  buildModMaskKeycode: (mask: number, key: number) => (mask === 0 ? key & 0xff : ((mask & 0x1f) << 8) | (key & 0xff)),
  buildModTapKeycode: (mask: number, key: number) => (mask === 0 ? key & 0xff : 0x6000 | ((mask & 0x1f) << 8) | (key & 0xff)),
}))

vi.mock('../ModifierCheckboxStrip', () => ({
  ModifierCheckboxStrip: () => null,
}))

vi.mock('../LayerSelector', () => ({
  LayerSelector: ({ layers, selectedLayer, onChange }: { layers: number; selectedLayer: number; onChange: (n: number) => void }) => (
    <div data-testid="layer-selector">
      {Array.from({ length: layers }, (_, i) => (
        <button key={i} data-testid={`layer-btn-${i}`} onClick={() => onChange(i)}>
          {selectedLayer === i ? `[${i}]` : `${i}`}
        </button>
      ))}
    </div>
  ),
}))

import { KeyPopover } from '../KeyPopover'
import { PopoverTabKey } from '../PopoverTabKey'

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

  it('calls onKeycodeSelect when result is clicked (basic key, no mode)', () => {
    // currentKeycode=4 (KC_A) is basic, so mode is 'none'
    renderAndSearch('A')
    fireEvent.click(screen.getByTestId('popover-result-KC_A'))
    expect(onKeycodeSelect).toHaveBeenCalledWith(expect.objectContaining({ qmkId: 'KC_A' }))
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

  it('shows "Selected" message instead of "No keycodes found" after selecting a result', () => {
    renderAndSearch('enter')
    fireEvent.click(screen.getByTestId('popover-result-KC_ENTER'))
    // After selection, results are suppressed but input shows the selected label
    const input = screen.getByTestId('popover-search-input') as HTMLInputElement
    expect(input.value).toBe('Enter')
    // Should show "Selected: Enter" instead of "No keycodes found"
    expect(screen.getByText('Selected: Enter')).toBeInTheDocument()
    expect(screen.queryByText('No keycodes found')).not.toBeInTheDocument()
  })

  it('clears "Selected" message when user types again', () => {
    renderAndSearch('enter')
    fireEvent.click(screen.getByTestId('popover-result-KC_ENTER'))
    expect(screen.getByText('Selected: Enter')).toBeInTheDocument()
    // Typing again should show search results, not "Selected" message
    fireEvent.change(screen.getByTestId('popover-search-input'), {
      target: { value: 'space' },
    })
    expect(screen.queryByText(/Selected:/)).not.toBeInTheDocument()
    expect(screen.getByTestId('popover-result-KC_SPACE')).toBeInTheDocument()
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

  it('calls onRawKeycodeSelect when apply is clicked (popover stays open)', () => {
    renderCodeTab('0005')
    fireEvent.click(screen.getByTestId('popover-code-apply'))
    expect(onRawKeycodeSelect).toHaveBeenCalledWith(5)
    expect(onClose).not.toHaveBeenCalled()
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
    expect(onClose).not.toHaveBeenCalled()
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
  // LSFT(KC_A) = 0x0204 — modifier mask keycode
  const lsftProps = {
    ...defaultProps,
    currentKeycode: 0x0204,
  }

  it('prefills search with inner keycode when modMask mode is active', () => {
    render(<KeyPopover {...lsftProps} />)
    const input = screen.getByTestId('popover-search-input') as HTMLInputElement
    // LSFT(KC_A) in modMask mode: should show "A" (inner basic key)
    expect(input.value).toBe('A')
  })

  it('prefills search with outer name for LT0 masked keycode (non-maskOnly)', () => {
    render(<KeyPopover {...defaultProps} currentKeycode={0x5104} />)
    const input = screen.getByTestId('popover-search-input') as HTMLInputElement
    // LT0(KC_A) in non-maskOnly: not modifiable, mode is 'none', shows outer name "LT0"
    expect(input.value).toBe('LT0')
  })

  it('prefills search with outer name for masked keycode with underscores in prefix', () => {
    render(<KeyPopover {...defaultProps} currentKeycode={0x2304} />)
    const input = screen.getByTestId('popover-search-input') as HTMLInputElement
    // C_S_T(KC_A) in non-maskOnly: not modifiable (> 0x1FFF), mode is 'none', shows outer name "C_S_T"
    expect(input.value).toBe('C_S_T')
  })
})

describe('PopoverTabKey — modMask transition preserves query', () => {
  const onSelect = vi.fn()

  it('keeps basic key results when modMask transitions from 0 to >0', () => {
    // Start with modMask=0, type "A" which matches basic key KC_A
    const { rerender } = render(
      <PopoverTabKey currentKeycode={4} modMask={0} onKeycodeSelect={onSelect} />,
    )
    fireEvent.change(screen.getByTestId('popover-search-input'), { target: { value: 'A' } })
    expect(screen.getByTestId('popover-result-KC_A')).toBeInTheDocument()

    // Transition modMask from 0 to 2 (LSft) — basic key "A" should still be visible
    rerender(<PopoverTabKey currentKeycode={0x0204} modMask={2} onKeycodeSelect={onSelect} />)
    const input = screen.getByTestId('popover-search-input') as HTMLInputElement
    expect(input.value).toBe('A')
    expect(screen.getByTestId('popover-result-KC_A')).toBeInTheDocument()
  })

  it('shows no results when modMask transition filters out non-basic query', () => {
    // Start with modMask=0, type "MO" which matches non-basic MO(1)
    const { rerender } = render(
      <PopoverTabKey currentKeycode={4} modMask={0} onKeycodeSelect={onSelect} />,
    )
    fireEvent.change(screen.getByTestId('popover-search-input'), { target: { value: 'MO' } })
    expect(screen.getByTestId('popover-result-MO(1)')).toBeInTheDocument()

    // Transition modMask from 0 to 2 — MO(1) is non-basic, should be filtered out
    rerender(<PopoverTabKey currentKeycode={0x0204} modMask={2} onKeycodeSelect={onSelect} />)
    const input = screen.getByTestId('popover-search-input') as HTMLInputElement
    expect(input.value).toBe('MO')
    expect(screen.queryByTestId('popover-result-MO(1)')).not.toBeInTheDocument()
    expect(screen.getByText('No keycodes found')).toBeInTheDocument()
  })
})

describe('PopoverTabKey — LM maskOnly initialQuery', () => {
  const onSelect = vi.fn()

  it('shows empty search input when LM key has no modifier (mod=0)', () => {
    // LM0 with mod=0 serializes as "LM0(0x0)" — inner is not a real keycode
    render(
      <PopoverTabKey currentKeycode={0x7000} maskOnly onKeycodeSelect={onSelect} />,
    )
    const input = screen.getByTestId('popover-search-input') as HTMLInputElement
    expect(input.value).toBe('')
  })

  it('shows stripped modifier name when LM key has a modifier set', () => {
    // LM0 with MOD_LSFT serializes as "LM0(MOD_LSFT)" — inner is MOD_LSFT
    render(
      <PopoverTabKey currentKeycode={0x7002} maskOnly onKeycodeSelect={onSelect} />,
    )
    const input = screen.getByTestId('popover-search-input') as HTMLInputElement
    expect(input.value).toBe('LSFT')
  })
})

describe('KeyPopover — LT/SH_T/LM wrapper modes', () => {
  it('shows 5 mode buttons when not maskOnly', () => {
    render(<KeyPopover {...defaultProps} />)
    expect(screen.getByTestId('popover-mode-mod-mask')).toBeInTheDocument()
    expect(screen.getByTestId('popover-mode-mod-tap')).toBeInTheDocument()
    expect(screen.getByTestId('popover-mode-lt')).toBeInTheDocument()
    expect(screen.getByTestId('popover-mode-sh-t')).toBeInTheDocument()
    expect(screen.getByTestId('popover-mode-lm')).toBeInTheDocument()
  })

  it('hides mode buttons in maskOnly mode', () => {
    render(<KeyPopover {...defaultProps} currentKeycode={0x5104} maskOnly />)
    expect(screen.queryByTestId('popover-mode-lt')).not.toBeInTheDocument()
    expect(screen.queryByTestId('popover-mode-sh-t')).not.toBeInTheDocument()
    expect(screen.queryByTestId('popover-mode-lm')).not.toBeInTheDocument()
  })

  it('auto-detects LT mode for LT keycode', () => {
    // LT1(KC_A) = 0x4104 — in the isLTKeycode range
    render(<KeyPopover {...defaultProps} currentKeycode={0x4104} />)
    // LT mode should be active: search shows inner basic key "A"
    const input = screen.getByTestId('popover-search-input') as HTMLInputElement
    expect(input.value).toBe('A')
    // Layer selector should be visible
    expect(screen.getByTestId('layer-selector')).toBeInTheDocument()
  })

  it('auto-detects SH_T mode for SH_T keycode', () => {
    // SH_T(KC_A) = 0x5604 — in the isSHTKeycode range
    render(<KeyPopover {...defaultProps} currentKeycode={0x5604} />)
    // SH_T mode should be active: search shows inner basic key "A"
    const input = screen.getByTestId('popover-search-input') as HTMLInputElement
    expect(input.value).toBe('A')
    // No layer selector for SH_T
    expect(screen.queryByTestId('layer-selector')).not.toBeInTheDocument()
  })

  it('auto-detects LM mode for LM keycode and hides search', () => {
    // LM0(MOD_LSFT) = 0x7002 — in the isLMKeycode range
    render(<KeyPopover {...defaultProps} currentKeycode={0x7002} />)
    // LM mode should be active: layer selector visible, search hidden
    expect(screen.getByTestId('layer-selector')).toBeInTheDocument()
    expect(screen.queryByTestId('popover-search-input')).not.toBeInTheDocument()
  })

  it('hides search and shows layer selector when switching to LM mode', () => {
    // Start with basic KC_A — search is visible
    render(<KeyPopover {...defaultProps} currentKeycode={4} />)
    expect(screen.getByTestId('popover-search-input')).toBeInTheDocument()
    expect(screen.queryByTestId('layer-selector')).not.toBeInTheDocument()
    // Switch to LM mode
    fireEvent.click(screen.getByTestId('popover-mode-lm'))
    // buildLMKeycode(0, 0) = 0x7000
    expect(onRawKeycodeSelect).toHaveBeenCalledWith(0x7000)
    // Search should be hidden, layer selector should appear
    expect(screen.queryByTestId('popover-search-input')).not.toBeInTheDocument()
    expect(screen.getByTestId('layer-selector')).toBeInTheDocument()
  })

  it('reverts to KC_NO when toggling LM mode off (LM has no basic key)', () => {
    render(<KeyPopover {...defaultProps} currentKeycode={0x7002} />)
    // LM mode is auto-detected. Click LM button to toggle off
    fireEvent.click(screen.getByTestId('popover-mode-lm'))
    // LM keycodes store modifiers in lower bits, not basic keys.
    // Toggling off should produce KC_NO (0), not the modifier value.
    expect(onRawKeycodeSelect).toHaveBeenCalledWith(0)
  })

  it('clears search when switching from LM to another mode', () => {
    // Start with LM keycode — search is hidden
    render(<KeyPopover {...defaultProps} currentKeycode={0x7002} />)
    expect(screen.queryByTestId('popover-search-input')).not.toBeInTheDocument()
    // Switch to LT mode — search should reappear (PopoverTabKey remounts via key={wrapperMode})
    fireEvent.click(screen.getByTestId('popover-mode-lt'))
    expect(screen.getByTestId('popover-search-input')).toBeInTheDocument()
  })

  it('does not leak LM modifier bits as basic key when switching to LT', () => {
    // LM0(MOD_LSFT) = 0x7002 — auto-detected as LM
    render(<KeyPopover {...defaultProps} currentKeycode={0x7002} layers={4} />)
    fireEvent.click(screen.getByTestId('popover-mode-lt'))
    // buildLTKeycode(0, 0) = 0x4000 — basicKey must be 0, not the modifier mask
    expect(onRawKeycodeSelect).toHaveBeenCalledWith(0x4000)
  })

  it('does not leak LM modifier bits as basic key when switching to SH_T', () => {
    render(<KeyPopover {...defaultProps} currentKeycode={0x7002} />)
    fireEvent.click(screen.getByTestId('popover-mode-sh-t'))
    // buildSHTKeycode(0) = 0x5600
    expect(onRawKeycodeSelect).toHaveBeenCalledWith(0x5600)
  })

  it('does not leak LM modifier bits as basic key when switching to modTap', () => {
    render(<KeyPopover {...defaultProps} currentKeycode={0x7002} />)
    fireEvent.click(screen.getByTestId('popover-mode-mod-tap'))
    // buildModTapKeycode(0, 0) = 0 (mask 0 returns basic key in mock)
    expect(onRawKeycodeSelect).toHaveBeenCalledWith(0)
  })

  it('does not leak LM modifier bits as basic key when switching to modMask', () => {
    render(<KeyPopover {...defaultProps} currentKeycode={0x7002} />)
    fireEvent.click(screen.getByTestId('popover-mode-mod-mask'))
    // buildModMaskKeycode(0, 0) = 0 (mask 0 returns basic key in mock)
    expect(onRawKeycodeSelect).toHaveBeenCalledWith(0)
  })

  it('builds LT keycode when selecting a key in LT mode', () => {
    render(<KeyPopover {...defaultProps} currentKeycode={0x4004} layers={4} />)
    // LT mode auto-detected, layer 0 selected
    fireEvent.change(screen.getByTestId('popover-search-input'), { target: { value: 'B' } })
    fireEvent.click(screen.getByTestId('popover-result-KC_B'))
    // buildLTKeycode(0, 5) = 0x4000 | (0 << 8) | 5 = 0x4005
    expect(onRawKeycodeSelect).toHaveBeenCalledWith(0x4005)
  })

  it('changes layer in LT mode and rebuilds keycode', () => {
    render(<KeyPopover {...defaultProps} currentKeycode={0x4004} layers={4} />)
    // Click layer 2 button
    fireEvent.click(screen.getByTestId('layer-btn-2'))
    // buildLTKeycode(2, 4) = 0x4000 | (2 << 8) | 4 = 0x4204
    expect(onRawKeycodeSelect).toHaveBeenCalledWith(0x4204)
  })

  it('builds SH_T keycode when selecting a key in SH_T mode', () => {
    // Start with basic KC_A, then enable SH_T mode
    render(<KeyPopover {...defaultProps} currentKeycode={4} />)
    fireEvent.click(screen.getByTestId('popover-mode-sh-t'))
    // Switching to SH_T mode: buildSHTKeycode(4) = 0x5600 | 4 = 0x5604
    expect(onRawKeycodeSelect).toHaveBeenCalledWith(0x5604)
  })

  it('reverts to basic key when toggling mode off', () => {
    render(<KeyPopover {...defaultProps} currentKeycode={0x4004} />)
    // LT mode is auto-detected. Click LT button to toggle off
    fireEvent.click(screen.getByTestId('popover-mode-lt'))
    // Should revert to basic key: extractBasicKey(0x4004) = 4
    expect(onRawKeycodeSelect).toHaveBeenCalledWith(4)
  })

  it('resets modifier mask to 0 when switching from LT to modTap', () => {
    // LT1(KC_A) = 0x4104 — bits 8-11 contain layer 1, not modifiers
    render(<KeyPopover {...defaultProps} currentKeycode={0x4104} />)
    // Auto-detected as LT. Switch to modTap
    fireEvent.click(screen.getByTestId('popover-mode-mod-tap'))
    // Should build modTap with mask=0 (not extracting layer bits as mods)
    // buildModTapKeycode(0, 4) = 4 (mask 0 returns basic key)
    expect(onRawKeycodeSelect).toHaveBeenCalledWith(4)
  })

  it('resets modifier mask to 0 when switching from SH_T to modMask', () => {
    // SH_T(KC_A) = 0x5604
    render(<KeyPopover {...defaultProps} currentKeycode={0x5604} />)
    // Auto-detected as SH_T. Switch to modMask
    fireEvent.click(screen.getByTestId('popover-mode-mod-mask'))
    // Should build modMask with mask=0 (not extracting SH_T prefix as mods)
    // buildModMaskKeycode(0, 4) = 4 (mask 0 returns basic key)
    expect(onRawKeycodeSelect).toHaveBeenCalledWith(4)
  })
})
