// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SplitKey, type SplitKeyProps } from '../SplitKey'
import { computeSplitSelectedPart } from '../KeycodeGrid'
import type { Keycode } from '../../../../shared/keycodes/keycodes'

const BASE: Keycode = { qmkId: 'KC_1', label: '1', keycode: 0x001e, hidden: false }
const SHIFTED: Keycode = { qmkId: 'KC_EXLM', label: '!', keycode: 0x021e, hidden: false }

function renderSplitKey(overrides: Partial<SplitKeyProps> = {}) {
  const defaults: SplitKeyProps = {
    base: BASE,
    shifted: SHIFTED,
    index: 3,
    shiftedIndex: 2,
    ...overrides,
  }
  return render(<SplitKey {...defaults} />)
}

describe('SplitKey', () => {
  it('renders base and shifted labels', () => {
    renderSplitKey()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('!')).toBeInTheDocument()
  })

  it('calls onClick with base keycode and base index on bottom click', () => {
    const onClick = vi.fn()
    renderSplitKey({ onClick })
    fireEvent.click(screen.getByText('1'))
    expect(onClick).toHaveBeenCalledWith(BASE, expect.any(Object), 3)
  })

  it('calls onClick with shifted keycode and shifted index on top click', () => {
    const onClick = vi.fn()
    renderSplitKey({ onClick })
    fireEvent.click(screen.getByText('!'))
    expect(onClick).toHaveBeenCalledWith(SHIFTED, expect.any(Object), 2)
  })

  it('highlights only base half when selectedPart is base', () => {
    renderSplitKey({ selectedPart: 'base' })
    const baseBtn = screen.getByText('1')
    const shiftedBtn = screen.getByText('!')
    expect(baseBtn.className).toContain('text-accent')
    expect(shiftedBtn.className).not.toContain('text-accent')
  })

  it('highlights only shifted half when selectedPart is shifted', () => {
    renderSplitKey({ selectedPart: 'shifted' })
    const baseBtn = screen.getByText('1')
    const shiftedBtn = screen.getByText('!')
    expect(baseBtn.className).not.toContain('text-accent')
    expect(shiftedBtn.className).toContain('text-accent')
  })

  it('highlights both halves when selectedPart is both', () => {
    renderSplitKey({ selectedPart: 'both' })
    const baseBtn = screen.getByText('1')
    const shiftedBtn = screen.getByText('!')
    expect(baseBtn.className).toContain('text-accent')
    expect(shiftedBtn.className).toContain('text-accent')
  })

  it('highlights neither half when selectedPart is undefined', () => {
    renderSplitKey({ selectedPart: undefined })
    const baseBtn = screen.getByText('1')
    const shiftedBtn = screen.getByText('!')
    // Neither should have the selected accent (only check for bg-accent/20 which is selection-specific)
    expect(baseBtn.className).not.toContain('bg-accent/20')
    expect(shiftedBtn.className).not.toContain('bg-accent/20')
  })
})

describe('computeSplitSelectedPart', () => {
  it('returns undefined when pickerSelectedIndices is empty', () => {
    expect(computeSplitSelectedPart(new Set(), 3, 2)).toBeUndefined()
  })

  it('returns undefined when pickerSelectedIndices is undefined', () => {
    expect(computeSplitSelectedPart(undefined, 3, 2)).toBeUndefined()
  })

  it('returns base when only base index is selected', () => {
    expect(computeSplitSelectedPart(new Set([3]), 3, 2)).toBe('base')
  })

  it('returns shifted when only shifted index is selected', () => {
    expect(computeSplitSelectedPart(new Set([2]), 3, 2)).toBe('shifted')
  })

  it('returns both when both indices are selected', () => {
    expect(computeSplitSelectedPart(new Set([2, 3]), 3, 2)).toBe('both')
  })

  it('returns undefined when neither index is selected', () => {
    expect(computeSplitSelectedPart(new Set([5, 6]), 3, 2)).toBeUndefined()
  })
})
