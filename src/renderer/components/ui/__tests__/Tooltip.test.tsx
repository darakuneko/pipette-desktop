// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Tooltip } from '../Tooltip'

describe('Tooltip', () => {
  it('renders tooltip bubble (portaled to body) with role="tooltip" and auto-generated id', () => {
    render(
      <Tooltip content="Hello">
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    const bubble = screen.getByRole('tooltip')
    expect(bubble).toBeDefined()
    expect(bubble.id).toMatch(/.+/)
    expect(bubble.textContent).toBe('Hello')
    // Portal target is document.body so the bubble escapes ancestor
    // overflow-clip / overflow-auto containers.
    expect(bubble.parentElement).toBe(document.body)
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

  it('applies openDelay as transitionDelay only while opening (closed = 0ms)', () => {
    const { container } = render(
      <Tooltip content="Help" openDelay={500}>
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    const bubble = screen.getByRole('tooltip')
    // Closed: instant fade-out (no delay).
    expect(bubble.style.transitionDelay).toBe('0ms')
    fireEvent.mouseEnter(container.firstElementChild!)
    expect(bubble.style.transitionDelay).toBe('500ms')
    fireEvent.mouseLeave(container.firstElementChild!)
    expect(bubble.style.transitionDelay).toBe('0ms')
  })

  it('clamps negative openDelay to 0 while open', () => {
    const { container } = render(
      <Tooltip content="Help" openDelay={-500}>
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    const bubble = screen.getByRole('tooltip')
    fireEvent.mouseEnter(container.firstElementChild!)
    expect(bubble.style.transitionDelay).toBe('0ms')
  })

  it('starts with the bubble hidden (opacity-0) and reveals on hover', () => {
    const { container } = render(
      <Tooltip content="Help">
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    const bubble = screen.getByRole('tooltip')
    expect(bubble.className).toContain('opacity-0')
    expect(bubble.className).not.toContain('opacity-100')
    const wrapper = container.firstElementChild!
    fireEvent.mouseEnter(wrapper)
    expect(bubble.className).toContain('opacity-100')
    fireEvent.mouseLeave(wrapper)
    expect(bubble.className).toContain('opacity-0')
  })

  it('opens on focus and closes on blur', () => {
    const { container } = render(
      <Tooltip content="Help">
        <button type="button">Trigger</button>
      </Tooltip>,
    )
    const bubble = screen.getByRole('tooltip')
    const wrapper = container.firstElementChild!
    fireEvent.focus(wrapper)
    expect(bubble.className).toContain('opacity-100')
    fireEvent.blur(wrapper)
    expect(bubble.className).toContain('opacity-0')
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
    expect(wrapper?.className).toContain('custom-wrapper')
  })

  it('renders wrapper as a span when wrapperAs="span"', () => {
    const { container } = render(
      <Tooltip content="Help" wrapperAs="span">
        <span>Trigger</span>
      </Tooltip>,
    )
    const wrapper = container.firstElementChild
    expect(wrapper?.tagName).toBe('SPAN')
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
