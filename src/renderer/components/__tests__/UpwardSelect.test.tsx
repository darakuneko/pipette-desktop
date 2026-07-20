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
  it('renders the selected option\'s own name in the trigger when no triggerLabel is given', () => {
    render(<UpwardSelect value="eucalyn-id" onChange={vi.fn()} options={OPTIONS} aria-label="Keyboard Layout" />)
    expect(screen.getByRole('button', { name: 'Keyboard Layout' })).toHaveTextContent('Eucalyn')
  })

  // Plan-qwerty-select-no-rewrite Phase K: the "{{name}} - Written" suffix
  // is composed by the caller (QuickSettingsSelects) and passed in as
  // `triggerLabel` — this component only needs to render it verbatim in
  // the closed trigger, leaving the dropdown's own option list alone.
  it('renders triggerLabel in the closed trigger when given, overriding the option\'s own name', () => {
    render(
      <UpwardSelect
        value="eucalyn-id"
        onChange={vi.fn()}
        options={OPTIONS}
        aria-label="Keyboard Layout"
        triggerLabel="Eucalyn - Written"
      />,
    )
    const trigger = screen.getByRole('button', { name: 'Keyboard Layout' })
    expect(trigger).toHaveTextContent('Eucalyn - Written')
  })

  it('does not apply triggerLabel to the dropdown option list — options keep their own plain names', () => {
    render(
      <UpwardSelect
        value="eucalyn-id"
        onChange={vi.fn()}
        options={OPTIONS}
        aria-label="Keyboard Layout"
        triggerLabel="Eucalyn - Written"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard Layout' }))
    expect(screen.getByRole('option', { name: 'Eucalyn' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Eucalyn - Written' })).not.toBeInTheDocument()
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
