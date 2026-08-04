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

  it('does not render a tag column when no option carries one (other call sites unaffected)', () => {
    render(<UpwardSelect value="qwerty" onChange={vi.fn()} options={OPTIONS} aria-label="Keyboard Layout" />)
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard Layout' }))
    expect(screen.getByRole('listbox').textContent).toBe('QWERTYEucalyn')
  })

  describe('per-option tag', () => {
    const TAGGED_OPTIONS = [
      { id: 'astarte', name: 'Astarte', tag: { label: 'Write', variant: 'accent' as const } },
      { id: 'mac', name: 'mac', tag: { label: 'View', variant: 'secondary' as const } },
      { id: 'plain', name: 'Plain' },
    ]

    it('renders each option\'s own tag next to its name, leaving untagged options bare', () => {
      render(<UpwardSelect value="astarte" onChange={vi.fn()} options={TAGGED_OPTIONS} aria-label="Keyboard Layout" />)
      fireEvent.click(screen.getByRole('button', { name: 'Keyboard Layout' }))
      const options = screen.getAllByRole('option')
      expect(options[0]).toHaveTextContent('AstarteWrite')
      expect(options[1]).toHaveTextContent('macView')
      expect(options[2]).toHaveTextContent('Plain')
      expect(options[2]).not.toHaveTextContent('Write')
      expect(options[2]).not.toHaveTextContent('View')
    })

    it('styles an accent-variant tag with the accent token and a secondary-variant tag with the secondary token', () => {
      render(<UpwardSelect value="astarte" onChange={vi.fn()} options={TAGGED_OPTIONS} aria-label="Keyboard Layout" />)
      fireEvent.click(screen.getByRole('button', { name: 'Keyboard Layout' }))
      expect(screen.getByText('Write').className).toContain('text-accent')
      expect(screen.getByText('View').className).toContain('text-content-secondary')
    })

    it('keeps the closed trigger showing only the selected name, never its tag', () => {
      render(<UpwardSelect value="astarte" onChange={vi.fn()} options={TAGGED_OPTIONS} aria-label="Keyboard Layout" />)
      const trigger = screen.getByRole('button', { name: 'Keyboard Layout' })
      expect(trigger).toHaveTextContent('Astarte')
      expect(trigger).not.toHaveTextContent('Write')
    })
  })

  describe('triggerName override (Task-qwerty-trigger-hide-default)', () => {
    const DEFAULT_SUFFIXED_OPTIONS = [
      { id: 'qwerty', name: 'QWERTY (Default)' },
      { id: 'eucalyn-id', name: 'Eucalyn' },
    ]

    it('shows the override on the closed trigger while the dropdown option keeps its own name', () => {
      render(
        <UpwardSelect
          value="qwerty"
          onChange={vi.fn()}
          options={DEFAULT_SUFFIXED_OPTIONS}
          aria-label="Keyboard Layout"
          triggerName="QWERTY"
        />,
      )
      const trigger = screen.getByRole('button', { name: 'Keyboard Layout' })
      expect(trigger).toHaveTextContent('QWERTY')
      expect(trigger).not.toHaveTextContent('QWERTY (Default)')

      fireEvent.click(trigger)
      expect(screen.getByRole('option', { name: 'QWERTY (Default)' })).toBeTruthy()
    })

    it('falls back to the matching option\'s own name when no override is passed', () => {
      render(
        <UpwardSelect
          value="qwerty"
          onChange={vi.fn()}
          options={DEFAULT_SUFFIXED_OPTIONS}
          aria-label="Keyboard Layout"
        />,
      )
      expect(screen.getByRole('button', { name: 'Keyboard Layout' })).toHaveTextContent('QWERTY (Default)')
    })
  })

  describe('footer overflow (Task-typing-record-footer min-width fix)', () => {
    it('truncates the trigger label to one line instead of wrapping when the footer runs out of room', () => {
      render(<UpwardSelect value="eucalyn-id" onChange={vi.fn()} options={OPTIONS} aria-label="Keyboard Layout" />)
      const trigger = screen.getByRole('button', { name: 'Keyboard Layout' })
      expect(trigger.className).toContain('min-w-16')
      const label = trigger.querySelector('span')
      expect(label?.className).toContain('truncate')
      expect(label?.className).toContain('min-w-0')
      expect(label?.className).toContain('flex-1')
    })

    it('keeps the chevron icon shrink-0 so truncation never swallows it', () => {
      render(<UpwardSelect value="eucalyn-id" onChange={vi.fn()} options={OPTIONS} aria-label="Keyboard Layout" />)
      const trigger = screen.getByRole('button', { name: 'Keyboard Layout' })
      const chevron = trigger.querySelector('svg')
      expect(chevron?.getAttribute('class')).toContain('shrink-0')
    })
  })
})
