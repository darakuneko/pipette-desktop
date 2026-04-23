// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Tooltip } from '../Tooltip'

describe('Tooltip', () => {
  it('renders tooltip bubble with role="tooltip" and auto-generated id', () => {
    render(
      <Tooltip content="Hello">
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    const bubble = screen.getByRole('tooltip')
    expect(bubble).toBeDefined()
    expect(bubble.id).toMatch(/.+/)
    expect(bubble.textContent).toBe('Hello')
  })

  it('connects aria-describedby from trigger to tooltip id', () => {
    render(
      <Tooltip content="Help">
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    const bubble = screen.getByRole('tooltip')
    const trigger = screen.getByRole('button', { name: 'Trigger' })
    expect(trigger.getAttribute('aria-describedby')).toBe(bubble.id)
  })

  it('merges existing aria-describedby on trigger with tooltip id', () => {
    render(
      <Tooltip content="Help">
        <button type="button" aria-describedby="existing-id">
          Trigger
        </button>
      </Tooltip>,
    )
    const bubble = screen.getByRole('tooltip')
    const trigger = screen.getByRole('button', { name: 'Trigger' })
    expect(trigger.getAttribute('aria-describedby')).toBe(`existing-id ${bubble.id}`)
  })

  it('does not render tooltip or add aria-describedby when disabled', () => {
    render(
      <Tooltip content="Help" disabled>
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    expect(screen.queryByRole('tooltip')).toBeNull()
    const trigger = screen.getByRole('button', { name: 'Trigger' })
    expect(trigger.hasAttribute('aria-describedby')).toBe(false)
  })

  it('preserves existing aria-describedby on trigger when disabled', () => {
    render(
      <Tooltip content="Help" disabled>
        <button type="button" aria-describedby="existing-id">
          Trigger
        </button>
      </Tooltip>,
    )
    const trigger = screen.getByRole('button', { name: 'Trigger' })
    expect(trigger.getAttribute('aria-describedby')).toBe('existing-id')
  })

  it('applies openDelay as transitionDelay inline style', () => {
    render(
      <Tooltip content="Help" openDelay={500}>
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    const bubble = screen.getByRole('tooltip')
    expect(bubble.style.transitionDelay).toBe('500ms')
  })

  it('supports openDelay={0} for instant show', () => {
    render(
      <Tooltip content="Help" openDelay={0}>
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    const bubble = screen.getByRole('tooltip')
    expect(bubble.style.transitionDelay).toBe('0ms')
  })

  it('applies offset as --tt-offset CSS variable', () => {
    render(
      <Tooltip content="Help" offset={12}>
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    const bubble = screen.getByRole('tooltip')
    expect(bubble.style.getPropertyValue('--tt-offset')).toBe('12px')
  })

  it('clamps negative offset and openDelay to 0', () => {
    render(
      <Tooltip content="Help" offset={-10} openDelay={-500}>
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    const bubble = screen.getByRole('tooltip')
    expect(bubble.style.getPropertyValue('--tt-offset')).toBe('0px')
    expect(bubble.style.transitionDelay).toBe('0ms')
  })

  it('uses default side="top" and align="center" when not specified', () => {
    render(
      <Tooltip content="Help">
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    const bubble = screen.getByRole('tooltip')
    expect(bubble.className).toContain('bottom-full')
    expect(bubble.className).toContain('left-1/2')
  })

  it('applies side="right" align="center" position classes', () => {
    render(
      <Tooltip content="Help" side="right">
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    const bubble = screen.getByRole('tooltip')
    expect(bubble.className).toContain('left-full')
    expect(bubble.className).toContain('top-1/2')
  })

  it('applies side="bottom" align="end" position classes', () => {
    render(
      <Tooltip content="Help" side="bottom" align="end">
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    const bubble = screen.getByRole('tooltip')
    expect(bubble.className).toContain('top-full')
    expect(bubble.className).toContain('right-0')
  })

  it('merges additional className into bubble', () => {
    render(
      <Tooltip content="Help" className="custom-bubble">
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    const bubble = screen.getByRole('tooltip')
    expect(bubble.className).toContain('custom-bubble')
  })

  it('merges wrapperClassName into wrapper element', () => {
    const { container } = render(
      <Tooltip content="Help" wrapperClassName="custom-wrapper">
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    const wrapper = container.firstElementChild
    expect(wrapper?.className).toContain('group/tt')
    expect(wrapper?.className).toContain('custom-wrapper')
  })

  it('includes hover and focus-within variant classes on bubble', () => {
    render(
      <Tooltip content="Help">
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    const bubble = screen.getByRole('tooltip')
    expect(bubble.className).toContain('group-hover/tt:opacity-100')
    expect(bubble.className).toContain('group-focus-within/tt:opacity-100')
  })

  it('renders wrapper as a span when wrapperAs="span"', () => {
    const { container } = render(
      <Tooltip content="Help" wrapperAs="span">
        <span>Trigger</span>
      </Tooltip>,
    )
    const wrapper = container.firstElementChild
    expect(wrapper?.tagName).toBe('SPAN')
    expect(wrapper?.className).toContain('group/tt')
  })

  it('renders bubble as a span when bubbleAs="span"', () => {
    render(
      <Tooltip content="Help" bubbleAs="span">
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    const bubble = screen.getByRole('tooltip')
    expect(bubble.tagName).toBe('SPAN')
    expect(bubble.textContent).toBe('Help')
  })

  it('applies wrapperProps attributes and merges className onto wrapper', () => {
    const { container } = render(
      <Tooltip
        content="Help"
        wrapperProps={{ role: 'cell', 'aria-label': 'cell-label', className: 'extra-class' }}
      >
        <span>Trigger</span>
      </Tooltip>,
    )
    const wrapper = container.firstElementChild
    expect(wrapper?.getAttribute('role')).toBe('cell')
    expect(wrapper?.getAttribute('aria-label')).toBe('cell-label')
    expect(wrapper?.className).toContain('extra-class')
    expect(wrapper?.className).toContain('group/tt')
  })

  it('puts aria-describedby on the wrapper when describedByOn="wrapper"', () => {
    const { container } = render(
      <Tooltip content="Help" describedByOn="wrapper">
        <span>Trigger</span>
      </Tooltip>,
    )
    const bubble = screen.getByRole('tooltip')
    const wrapper = container.firstElementChild
    const trigger = wrapper?.firstElementChild
    expect(wrapper?.getAttribute('aria-describedby')).toBe(bubble.id)
    expect(trigger?.hasAttribute('aria-describedby')).toBe(false)
  })

  it('merges existing aria-describedby on wrapperProps when describedByOn="wrapper"', () => {
    const { container } = render(
      <Tooltip
        content="Help"
        describedByOn="wrapper"
        wrapperProps={{ 'aria-describedby': 'existing-id' }}
      >
        <span>Trigger</span>
      </Tooltip>,
    )
    const bubble = screen.getByRole('tooltip')
    const wrapper = container.firstElementChild
    expect(wrapper?.getAttribute('aria-describedby')).toBe(`existing-id ${bubble.id}`)
  })

  it('uses whitespace-pre-line on the bubble so "\\n" in content renders as a line break', () => {
    render(
      <Tooltip content={'first line\nsecond line'}>
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    const bubble = screen.getByRole('tooltip')
    expect(bubble.className).toContain('whitespace-pre-line')
    expect(bubble.textContent).toBe('first line\nsecond line')
  })

  it('lets wrapperClassName override wrapperProps.className on the wrapper', () => {
    const { container } = render(
      <Tooltip
        content="Help"
        wrapperProps={{ className: 'props-class' }}
        wrapperClassName="dedicated-class"
      >
        <span>Trigger</span>
      </Tooltip>,
    )
    const wrapper = container.firstElementChild
    const classes = wrapper?.className ?? ''
    expect(classes).toContain('props-class')
    expect(classes).toContain('dedicated-class')
    expect(classes.indexOf('props-class')).toBeLessThan(classes.indexOf('dedicated-class'))
  })
})
