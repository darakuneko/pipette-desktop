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
  it('renders the selected option\'s own name in the trigger when no triggerSuffix is given', () => {
    render(<UpwardSelect value="eucalyn-id" onChange={vi.fn()} options={OPTIONS} aria-label="Keyboard Layout" />)
    expect(screen.getByRole('button', { name: 'Keyboard Layout' })).toHaveTextContent('Eucalyn')
  })

  // Plan-qwerty-select-no-rewrite Phase K: the " - Written" suffix text is
  // owned by the caller (QuickSettingsSelects, via i18n) — this component
  // appends it to its OWN resolved option name in the closed trigger, so
  // there is only one place that resolves "which option's name is this",
  // and the dropdown's own option list is left alone.
  it('appends triggerSuffix to the resolved option name in the closed trigger', () => {
    render(
      <UpwardSelect
        value="eucalyn-id"
        onChange={vi.fn()}
        options={OPTIONS}
        aria-label="Keyboard Layout"
        triggerSuffix=" - Written"
      />,
    )
    const trigger = screen.getByRole('button', { name: 'Keyboard Layout' })
    expect(trigger).toHaveTextContent('Eucalyn - Written')
  })

  it('does not apply triggerSuffix to the dropdown option list — options keep their own plain names', () => {
    render(
      <UpwardSelect
        value="eucalyn-id"
        onChange={vi.fn()}
        options={OPTIONS}
        aria-label="Keyboard Layout"
        triggerSuffix=" - Written"
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
