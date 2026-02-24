// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MacroActionItem } from '../MacroActionItem'
import type { MacroAction } from '../../../../preload/macro'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'editor.macro.text': 'Text',
        'editor.macro.tap': 'Tap',
        'editor.macro.down': 'Down',
        'editor.macro.up': 'Up',
        'editor.macro.delay': 'Delay',
        'editor.macro.addKeycode': 'Add keycode',
        'editor.macro.asciiOnly': 'Only ASCII characters (A-Z, 0-9, symbols) are supported',
      }
      return map[key] ?? key
    },
  }),
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (kc: number) => `KC_${kc.toString(16).toUpperCase()}`,
  keycodeLabel: (qmkId: string) => qmkId,
  keycodeTooltip: (qmkId: string) => qmkId,
  isModifiableKeycode: () => false,
  extractModMask: () => 0,
  extractBasicKey: (code: number) => code & 0xff,
  buildModMaskKeycode: (mask: number, key: number) => (mask << 8) | key,
  isMask: () => false,
  findOuterKeycode: () => undefined,
  findInnerKeycode: () => undefined,
}))

describe('MacroActionItem', () => {
  const defaultCallbacks = {
    onChange: vi.fn(),
    onDelete: vi.fn(),
    onDragStart: vi.fn(),
    onDragOver: vi.fn(),
    onDrop: vi.fn(),
    onDragEnd: vi.fn(),
    dropIndicator: null as 'above' | 'below' | null,
    selectedKeycodeIndex: null as number | null,
    onKeycodeClick: vi.fn(),
    onKeycodeDoubleClick: vi.fn(),
    onKeycodeAdd: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('text action', () => {
    const textAction: MacroAction = { type: 'text', text: 'hello' }

    it('renders text input with value', () => {
      render(
        <MacroActionItem action={textAction} index={0} {...defaultCallbacks} />,
      )
      const input = screen.getByPlaceholderText('Text') as HTMLInputElement
      expect(input.value).toBe('hello')
    })

    it('calls onChange when text is edited', () => {
      const onChange = vi.fn()
      render(
        <MacroActionItem action={textAction} index={2} {...defaultCallbacks} onChange={onChange} />,
      )
      fireEvent.change(screen.getByPlaceholderText('Text'), { target: { value: 'world' } })
      expect(onChange).toHaveBeenCalledWith(2, { type: 'text', text: 'world' })
    })

    it('shows no warning for valid ASCII text', () => {
      render(
        <MacroActionItem action={textAction} index={0} {...defaultCallbacks} />,
      )
      expect(screen.queryByText('Only ASCII characters (A-Z, 0-9, symbols) are supported')).not.toBeInTheDocument()
      const input = screen.getByPlaceholderText('Text')
      expect(input.className).toContain('border-edge')
    })

    it('shows warning and red border for non-ASCII text', () => {
      const nonAsciiAction: MacroAction = { type: 'text', text: 'こんにちは' }
      render(
        <MacroActionItem action={nonAsciiAction} index={0} {...defaultCallbacks} />,
      )
      expect(screen.getByText('Only ASCII characters (A-Z, 0-9, symbols) are supported')).toBeInTheDocument()
      const input = screen.getByPlaceholderText('Text')
      expect(input.className).toContain('border-danger')
    })

    it('shows warning for mixed ASCII and non-ASCII text', () => {
      const mixedAction: MacroAction = { type: 'text', text: 'Hello こんにちは' }
      render(
        <MacroActionItem action={mixedAction} index={0} {...defaultCallbacks} />,
      )
      expect(screen.getByText('Only ASCII characters (A-Z, 0-9, symbols) are supported')).toBeInTheDocument()
    })
  })

  describe('tap action', () => {
    it('renders KeycodeField buttons for keycodes', () => {
      const tapAction: MacroAction = { type: 'tap', keycodes: [0x41] }
      render(
        <MacroActionItem action={tapAction} index={0} {...defaultCallbacks} />,
      )
      const keycodeFields = screen.getAllByTestId('keycode-field')
      expect(keycodeFields).toHaveLength(1)
    })

    it('renders multiple KeycodeField buttons for multiple keycodes', () => {
      const multiAction: MacroAction = { type: 'tap', keycodes: [0x04, 0x05] }
      render(
        <MacroActionItem action={multiAction} index={0} {...defaultCallbacks} />,
      )
      const keycodeFields = screen.getAllByTestId('keycode-field')
      expect(keycodeFields).toHaveLength(2)
    })

    it('renders add keycode button', () => {
      const tapAction: MacroAction = { type: 'tap', keycodes: [0x41] }
      render(
        <MacroActionItem action={tapAction} index={0} {...defaultCallbacks} />,
      )
      expect(screen.getByTestId('macro-add-keycode')).toBeInTheDocument()
    })

    it('calls onKeycodeAdd when + button is clicked', () => {
      const onKeycodeAdd = vi.fn()
      const tapAction: MacroAction = { type: 'tap', keycodes: [0x41] }
      render(
        <MacroActionItem action={tapAction} index={0} {...defaultCallbacks} onKeycodeAdd={onKeycodeAdd} />,
      )
      fireEvent.click(screen.getByTestId('macro-add-keycode'))
      expect(onKeycodeAdd).toHaveBeenCalled()
    })

    it('calls onKeycodeClick when keycode button is clicked', () => {
      const onKeycodeClick = vi.fn()
      const tapAction: MacroAction = { type: 'tap', keycodes: [0x41] }
      render(
        <MacroActionItem action={tapAction} index={0} {...defaultCallbacks} onKeycodeClick={onKeycodeClick} />,
      )
      fireEvent.click(screen.getByTestId('keycode-field'))
      // KeycodeField uses a timeout for single click when onDoubleClick is not provided
      // When not selected, onDoubleClick is undefined so click fires immediately
      expect(onKeycodeClick).toHaveBeenCalledWith(0)
    })

    it('reflects selectedKeycodeIndex via aria-pressed', () => {
      const tapAction: MacroAction = { type: 'tap', keycodes: [0x41, 0x42] }
      render(
        <MacroActionItem action={tapAction} index={0} {...defaultCallbacks} selectedKeycodeIndex={0} />,
      )
      const keycodeFields = screen.getAllByTestId('keycode-field')
      expect(keycodeFields[0]).toHaveAttribute('aria-pressed', 'true')
      expect(keycodeFields[1]).toHaveAttribute('aria-pressed', 'false')
    })
  })

  describe('down action', () => {
    it('renders KeycodeField button', () => {
      render(
        <MacroActionItem action={{ type: 'down', keycodes: [0x10] }} index={0} {...defaultCallbacks} />,
      )
      expect(screen.getByTestId('keycode-field')).toBeInTheDocument()
    })
  })

  describe('up action', () => {
    it('renders KeycodeField button', () => {
      render(
        <MacroActionItem action={{ type: 'up', keycodes: [0x20] }} index={0} {...defaultCallbacks} />,
      )
      expect(screen.getByTestId('keycode-field')).toBeInTheDocument()
    })
  })

  describe('delay action', () => {
    const delayAction: MacroAction = { type: 'delay', delay: 250 }

    it('renders number input with delay value', () => {
      render(
        <MacroActionItem action={delayAction} index={0} {...defaultCallbacks} />,
      )
      const input = screen.getByDisplayValue('250') as HTMLInputElement
      expect(input.type).toBe('number')
    })

    it('shows ms label', () => {
      render(
        <MacroActionItem action={delayAction} index={0} {...defaultCallbacks} />,
      )
      expect(screen.getByText('ms')).toBeInTheDocument()
    })

    it('calls onChange with parsed delay value', () => {
      const onChange = vi.fn()
      render(
        <MacroActionItem action={delayAction} index={1} {...defaultCallbacks} onChange={onChange} />,
      )
      fireEvent.change(screen.getByDisplayValue('250'), { target: { value: '500' } })
      expect(onChange).toHaveBeenCalledWith(1, { type: 'delay', delay: 500 })
    })

    it('clamps negative delay to 0', () => {
      const onChange = vi.fn()
      render(
        <MacroActionItem action={delayAction} index={0} {...defaultCallbacks} onChange={onChange} />,
      )
      fireEvent.change(screen.getByDisplayValue('250'), { target: { value: '-10' } })
      expect(onChange).toHaveBeenCalledWith(0, { type: 'delay', delay: 0 })
    })
  })

  describe('type label', () => {
    it('displays the action type as a text label', () => {
      render(
        <MacroActionItem action={{ type: 'tap', keycodes: [0] }} index={0} {...defaultCallbacks} />,
      )
      expect(screen.getByText('Tap')).toBeInTheDocument()
    })
  })

  describe('drag handle and delete', () => {
    it('has a draggable handle', () => {
      render(
        <MacroActionItem action={{ type: 'text', text: '' }} index={0} {...defaultCallbacks} />,
      )
      const handle = screen.getByTestId('drag-handle')
      expect(handle).toHaveAttribute('draggable', 'true')
    })

    it('calls onDelete with index when delete button clicked', () => {
      const onDelete = vi.fn()
      render(
        <MacroActionItem action={{ type: 'text', text: '' }} index={4} {...defaultCallbacks} onDelete={onDelete} />,
      )
      const buttons = screen.getAllByRole('button')
      fireEvent.click(buttons[buttons.length - 1])
      expect(onDelete).toHaveBeenCalledWith(4)
    })

    it('shows top indicator when dropIndicator is above', () => {
      const { container } = render(
        <MacroActionItem action={{ type: 'text', text: '' }} index={0} {...defaultCallbacks} dropIndicator="above" />,
      )
      const outerDiv = container.firstElementChild as HTMLElement
      expect(outerDiv.className).toContain('border-t-accent')
    })

    it('shows bottom indicator when dropIndicator is below', () => {
      const { container } = render(
        <MacroActionItem action={{ type: 'text', text: '' }} index={0} {...defaultCallbacks} dropIndicator="below" />,
      )
      const outerDiv = container.firstElementChild as HTMLElement
      expect(outerDiv.className).toContain('border-b-accent')
    })
  })
})
