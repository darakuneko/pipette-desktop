// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { UpwardSelect } from '../UpwardSelect'

const OPTIONS = [
  { id: 'qwerty', name: 'QWERTY' },
  { id: 'eucalyn-id', name: 'Eucalyn' },
]

describe('UpwardSelect', () => {
  it('renders the selected option\'s own name in the trigger', () => {
    render(<UpwardSelect value="eucalyn-id" onChange={vi.fn()} options={OPTIONS} aria-label="Keyboard Layout" />)
    expect(screen.getByRole('button', { name: 'Keyboard Layout' })).toHaveTextContent('Eucalyn')
  })

  it('falls back to the raw value when the selected id has no matching option', () => {
    render(<UpwardSelect value="unknown-id" onChange={vi.fn()} options={OPTIONS} aria-label="Keyboard Layout" />)
    expect(screen.getByRole('button', { name: 'Keyboard Layout' })).toHaveTextContent('unknown-id')
  })

  it('calls onChange with the picked option id and closes the dropdown', () => {
    const onChange = vi.fn()
    render(<UpwardSelect value="qwerty" onChange={onChange} options={OPTIONS} aria-label="Keyboard Layout" />)
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard Layout' }))
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Eucalyn' }))
    expect(onChange).toHaveBeenCalledWith('eucalyn-id')
  })
})
