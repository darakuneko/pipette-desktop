// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { KeycodeButton } from '../KeycodeButton'

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  Keycode: class MockKeycode {
    qmkId: string
    label: string
    tooltip: string | undefined
    masked: boolean
    printable: string | undefined
    alias: string[]
    requiresFeature: string | undefined
    hidden = false
    constructor(opts: Record<string, unknown>) {
      this.qmkId = opts.qmkId as string
      this.label = opts.label as string
      this.tooltip = opts.tooltip as string | undefined
      this.masked = (opts.masked as boolean) ?? false
      this.printable = opts.printable as string | undefined
      this.alias = [this.qmkId, ...((opts.alias as string[]) ?? [])]
      this.requiresFeature = opts.requiresFeature as string | undefined
    }
    isSupportedBy() {
      return true
    }
  },
}))

import { Keycode } from '../../../../shared/keycodes/keycodes'

function makeKeycode(overrides: Partial<{ qmkId: string; label: string }> = {}) {
  return new Keycode({ qmkId: overrides.qmkId ?? 'KC_A', label: overrides.label ?? 'A' })
}

describe('KeycodeButton', () => {
  it('renders the label text', () => {
    render(<KeycodeButton keycode={makeKeycode({ qmkId: 'KC_B', label: 'B' })} />)
    expect(screen.getByText('B')).toBeInTheDocument()
  })

  it('renders multiline labels as separate spans', () => {
    render(<KeycodeButton keycode={makeKeycode({ qmkId: 'KC_ENTER', label: 'Num\nEnter' })} />)
    expect(screen.getByText('Num')).toBeInTheDocument()
    expect(screen.getByText('Enter')).toBeInTheDocument()
  })

  it('calls onHover with keycode and rect on mouseenter', () => {
    const onHover = vi.fn()
    const kc = makeKeycode({ qmkId: 'KC_C', label: 'C' })
    render(<KeycodeButton keycode={kc} onHover={onHover} />)
    fireEvent.mouseEnter(screen.getByRole('button'))
    expect(onHover).toHaveBeenCalledWith(kc, expect.any(Object))
  })

  it('calls onHoverEnd on mouseleave', () => {
    const onHoverEnd = vi.fn()
    render(<KeycodeButton keycode={makeKeycode({ qmkId: 'KC_C', label: 'C' })} onHoverEnd={onHoverEnd} />)
    fireEvent.mouseLeave(screen.getByRole('button'))
    expect(onHoverEnd).toHaveBeenCalled()
  })

  it('calls onClick with keycode when clicked', () => {
    const onClick = vi.fn()
    const kc = makeKeycode({ qmkId: 'KC_D', label: 'D' })
    render(<KeycodeButton keycode={kc} onClick={onClick} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledWith(kc, expect.any(Object))
  })

  it('renders nothing when keycode is hidden', () => {
    const kc = makeKeycode({ qmkId: 'KC_HIDDEN', label: 'Hidden' })
    kc.hidden = true
    const { container } = render(<KeycodeButton keycode={kc} />)
    expect(container.innerHTML).toBe('')
  })

  it('does not throw when clicked without onClick handler', () => {
    render(<KeycodeButton keycode={makeKeycode({ qmkId: 'KC_E', label: 'E' })} />)
    expect(() => fireEvent.click(screen.getByRole('button'))).not.toThrow()
  })

  it('renders as a button element with type="button"', () => {
    render(<KeycodeButton keycode={makeKeycode({ qmkId: 'KC_F', label: 'F' })} />)
    const button = screen.getByRole('button')
    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveAttribute('type', 'button')
  })

  it('handles single-line label with one span', () => {
    render(<KeycodeButton keycode={makeKeycode({ qmkId: 'KC_G', label: 'G' })} />)
    const spans = screen.getByRole('button').querySelectorAll('span')
    expect(spans).toHaveLength(1)
    expect(spans[0].textContent).toBe('G')
  })

  it('applies accent styling when highlighted', () => {
    render(<KeycodeButton keycode={makeKeycode({ qmkId: 'KC_J', label: 'J' })} highlighted />)
    const btn = screen.getByRole('button')
    expect(btn.className).toContain('text-accent')
    expect(btn.className).toContain('bg-accent/10')
  })

  it('applies default styling when not highlighted', () => {
    render(<KeycodeButton keycode={makeKeycode({ qmkId: 'KC_K', label: 'K' })} />)
    const btn = screen.getByRole('button')
    expect(btn.className).toContain('text-picker-item-text')
    expect(btn.className).not.toContain('text-accent')
  })

  it('selected takes precedence over highlighted', () => {
    render(<KeycodeButton keycode={makeKeycode({ qmkId: 'KC_L', label: 'L' })} selected highlighted />)
    const btn = screen.getByRole('button')
    expect(btn.className).toContain('ring-accent')
    expect(btn.className).toContain('bg-accent/20')
    // Should NOT have the highlighted-only style
    expect(btn.className).not.toContain('bg-accent/10')
  })
})
