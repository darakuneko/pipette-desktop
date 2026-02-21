// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ModifierCheckboxStrip } from '../ModifierCheckboxStrip'

describe('ModifierCheckboxStrip', () => {
  it('renders 8 buttons', () => {
    render(<ModifierCheckboxStrip modMask={0} onChange={() => {}} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(8)
  })

  it('renders all modifier labels', () => {
    render(<ModifierCheckboxStrip modMask={0} onChange={() => {}} />)
    expect(screen.getByText('LCtl')).toBeInTheDocument()
    expect(screen.getByText('LSft')).toBeInTheDocument()
    expect(screen.getByText('LAlt')).toBeInTheDocument()
    expect(screen.getByText('LGui')).toBeInTheDocument()
    expect(screen.getByText('RCtl')).toBeInTheDocument()
    expect(screen.getByText('RSft')).toBeInTheDocument()
    expect(screen.getByText('RAlt')).toBeInTheDocument()
    expect(screen.getByText('RGui')).toBeInTheDocument()
  })

  it('shows all inactive when modMask is 0', () => {
    render(<ModifierCheckboxStrip modMask={0} onChange={() => {}} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons.every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true)
  })

  it('all buttons enabled when modMask is 0', () => {
    render(<ModifierCheckboxStrip modMask={0} onChange={() => {}} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons.every((b) => !b.hasAttribute('disabled'))).toBe(true)
  })

  it('activates LCtl when modMask has bit 0 set (left side)', () => {
    render(<ModifierCheckboxStrip modMask={0x01} onChange={() => {}} />)
    expect(screen.getByTestId('mod-LCtl')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('mod-LSft')).toHaveAttribute('aria-pressed', 'false')
  })

  it('activates LSft when modMask has bit 1 set (left side)', () => {
    render(<ModifierCheckboxStrip modMask={0x02} onChange={() => {}} />)
    expect(screen.getByTestId('mod-LSft')).toHaveAttribute('aria-pressed', 'true')
  })

  it('activates LCtl+LSft when modMask is 0x03', () => {
    render(<ModifierCheckboxStrip modMask={0x03} onChange={() => {}} />)
    expect(screen.getByTestId('mod-LCtl')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('mod-LSft')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('mod-LAlt')).toHaveAttribute('aria-pressed', 'false')
  })

  it('activates RSft when modMask is 0x12 (right flag + SFT)', () => {
    render(<ModifierCheckboxStrip modMask={0x12} onChange={() => {}} />)
    expect(screen.getByTestId('mod-RSft')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('mod-LSft')).toHaveAttribute('aria-pressed', 'false')
  })

  it('calls onChange with toggled bit when LCtl is clicked', () => {
    const onChange = vi.fn()
    render(<ModifierCheckboxStrip modMask={0} onChange={onChange} />)
    fireEvent.click(screen.getByTestId('mod-LCtl'))
    expect(onChange).toHaveBeenCalledWith(0x01)
  })

  it('calls onChange to deactivate when LCtl is toggled off (was only modifier)', () => {
    const onChange = vi.fn()
    render(<ModifierCheckboxStrip modMask={0x01} onChange={onChange} />)
    fireEvent.click(screen.getByTestId('mod-LCtl'))
    expect(onChange).toHaveBeenCalledWith(0x00)
  })

  it('disables right buttons when left modifiers are active', () => {
    render(<ModifierCheckboxStrip modMask={0x03} onChange={() => {}} />)
    expect(screen.getByTestId('mod-RCtl')).toBeDisabled()
    expect(screen.getByTestId('mod-RSft')).toBeDisabled()
    expect(screen.getByTestId('mod-RAlt')).toBeDisabled()
    expect(screen.getByTestId('mod-RGui')).toBeDisabled()
    // Left side remains enabled
    expect(screen.getByTestId('mod-LCtl')).not.toBeDisabled()
    expect(screen.getByTestId('mod-LAlt')).not.toBeDisabled()
  })

  it('disables left buttons when right modifiers are active', () => {
    render(<ModifierCheckboxStrip modMask={0x12} onChange={() => {}} />)
    expect(screen.getByTestId('mod-LCtl')).toBeDisabled()
    expect(screen.getByTestId('mod-LSft')).toBeDisabled()
    expect(screen.getByTestId('mod-LAlt')).toBeDisabled()
    expect(screen.getByTestId('mod-LGui')).toBeDisabled()
    // Right side remains enabled
    expect(screen.getByTestId('mod-RCtl')).not.toBeDisabled()
    expect(screen.getByTestId('mod-RSft')).not.toBeDisabled()
  })

  it('adds multiple left modifiers without clearing', () => {
    const onChange = vi.fn()
    render(<ModifierCheckboxStrip modMask={0x01} onChange={onChange} />)
    // LCtl active, click LSft
    fireEvent.click(screen.getByTestId('mod-LSft'))
    expect(onChange).toHaveBeenCalledWith(0x03) // LCtl + LSft
  })

  it('adds multiple right modifiers without clearing', () => {
    const onChange = vi.fn()
    render(<ModifierCheckboxStrip modMask={0x11} onChange={onChange} />)
    // RCtl active, click RSft
    fireEvent.click(screen.getByTestId('mod-RSft'))
    expect(onChange).toHaveBeenCalledWith(0x13) // right flag + CTL + SFT
  })

  it('disabled buttons do not fire onChange', () => {
    const onChange = vi.fn()
    render(<ModifierCheckboxStrip modMask={0x01} onChange={onChange} />)
    // Right side is disabled, clicking should not call onChange
    fireEvent.click(screen.getByTestId('mod-RCtl'))
    expect(onChange).not.toHaveBeenCalled()
  })
})
