// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { KeycodeField } from '../KeycodeField'

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => (code === 0 ? 'KC_NO' : `KC_${code}`),
  keycodeLabel: (qmkId: string) => {
    if (qmkId === 'KC_NO') return 'None'
    if (qmkId === 'KC_99') return 'Line1\nLine2'
    return qmkId
  },
  keycodeTooltip: (qmkId: string) => (qmkId === 'KC_NO' ? undefined : `Tooltip: ${qmkId}`),
  isMask: () => false,
  findOuterKeycode: () => undefined,
  findInnerKeycode: () => undefined,
}))

describe('KeycodeField', () => {
  it('renders an svg element inside the button', () => {
    render(<KeycodeField value={0} selected={false} onSelect={() => {}} />)
    const btn = screen.getByTestId('keycode-field')
    expect(btn.querySelector('svg')).not.toBeNull()
  })

  it('calls onSelect when clicked', () => {
    const onSelect = vi.fn()
    render(<KeycodeField value={0} selected={false} onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId('keycode-field'))
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('sets aria-label when provided', () => {
    render(
      <KeycodeField value={0} selected={false} onSelect={() => {}} label="Trigger Key" />,
    )
    expect(screen.getByTestId('keycode-field')).toHaveAttribute('aria-label', 'Trigger Key')
  })

  it('sets aria-pressed based on selected state', () => {
    const { rerender } = render(
      <KeycodeField value={0} selected={false} onSelect={() => {}} />,
    )
    expect(screen.getByTestId('keycode-field')).toHaveAttribute('aria-pressed', 'false')
    rerender(<KeycodeField value={0} selected={true} onSelect={() => {}} />)
    expect(screen.getByTestId('keycode-field')).toHaveAttribute('aria-pressed', 'true')
  })

  it('sets title from keycodeTooltip', () => {
    render(<KeycodeField value={4} selected={false} onSelect={() => {}} />)
    expect(screen.getByTestId('keycode-field')).toHaveAttribute('title', 'Tooltip: KC_4')
  })

  it('does not set title when tooltip is undefined', () => {
    render(<KeycodeField value={0} selected={false} onSelect={() => {}} />)
    expect(screen.getByTestId('keycode-field')).not.toHaveAttribute('title')
  })

  it('delays onSelect when onDoubleClick is provided', () => {
    vi.useFakeTimers()
    const onSelect = vi.fn()
    const onDoubleClick = vi.fn()
    render(
      <KeycodeField value={0} selected={false} onSelect={onSelect} onDoubleClick={onDoubleClick} />,
    )
    fireEvent.click(screen.getByTestId('keycode-field'))
    expect(onSelect).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(onSelect).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('calls onDoubleClick on double-click and cancels pending select', () => {
    vi.useFakeTimers()
    const onSelect = vi.fn()
    const onDoubleClick = vi.fn()
    render(
      <KeycodeField value={0} selected={false} onSelect={onSelect} onDoubleClick={onDoubleClick} />,
    )
    const btn = screen.getByTestId('keycode-field')
    fireEvent.click(btn)
    fireEvent.doubleClick(btn)
    vi.advanceTimersByTime(300)
    expect(onDoubleClick).toHaveBeenCalledOnce()
    expect(onSelect).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
