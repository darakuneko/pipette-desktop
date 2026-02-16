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
}))

describe('KeycodeField', () => {
  it('renders the keycode label', () => {
    render(<KeycodeField value={0} selected={false} onSelect={() => {}} />)
    expect(screen.getByTestId('keycode-field')).toHaveTextContent('None')
  })

  it('renders label for non-zero keycode', () => {
    render(<KeycodeField value={4} selected={false} onSelect={() => {}} />)
    expect(screen.getByTestId('keycode-field')).toHaveTextContent('KC_4')
  })

  it('renders multi-line labels as separate spans', () => {
    render(<KeycodeField value={99} selected={false} onSelect={() => {}} />)
    const btn = screen.getByTestId('keycode-field')
    const spans = btn.querySelectorAll('span')
    expect(spans).toHaveLength(2)
    expect(spans[0]).toHaveTextContent('Line1')
    expect(spans[1]).toHaveTextContent('Line2')
  })

  it('applies selected styles when selected', () => {
    render(<KeycodeField value={0} selected={true} onSelect={() => {}} />)
    const btn = screen.getByTestId('keycode-field')
    expect(btn.className).toContain('border-accent')
    expect(btn.className).toContain('ring-2')
  })

  it('applies non-selected styles when not selected', () => {
    render(<KeycodeField value={0} selected={false} onSelect={() => {}} />)
    const btn = screen.getByTestId('keycode-field')
    expect(btn.className).toContain('border-picker-item-border')
    expect(btn.className).not.toContain('ring-2')
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
})
