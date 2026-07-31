// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { useEscapeClose, useEscapeCloseCapture, useEscapeSwallow } from '../useEscapeClose'

function pressEscape(target: EventTarget = window, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }))
}

describe('useEscapeClose', () => {
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('calls onClose when Escape is pressed on window', () => {
    const onClose = vi.fn()
    renderHook(() => useEscapeClose(onClose))
    pressEscape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not call onClose for non-Escape keys', () => {
    const onClose = vi.fn()
    renderHook(() => useEscapeClose(onClose))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not call onClose when disabled', () => {
    const onClose = vi.fn()
    renderHook(() => useEscapeClose(onClose, false))
    pressEscape()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('skips close when an INPUT is focused', () => {
    const onClose = vi.fn()
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    renderHook(() => useEscapeClose(onClose))
    pressEscape(input)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('skips close when a TEXTAREA is focused', () => {
    const onClose = vi.fn()
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()
    renderHook(() => useEscapeClose(onClose))
    pressEscape(textarea)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('skips close when a SELECT is focused', () => {
    const onClose = vi.fn()
    const select = document.createElement('select')
    document.body.appendChild(select)
    select.focus()
    renderHook(() => useEscapeClose(onClose))
    pressEscape(select)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('skips close when a contenteditable element is focused', () => {
    const onClose = vi.fn()
    const div = document.createElement('div')
    div.setAttribute('contenteditable', 'true')
    div.tabIndex = 0
    document.body.appendChild(div)
    div.focus()
    renderHook(() => useEscapeClose(onClose))
    pressEscape(div)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('skips close when a descendant of a contenteditable region is focused', () => {
    const onClose = vi.fn()
    const outer = document.createElement('div')
    outer.setAttribute('contenteditable', 'true')
    const inner = document.createElement('span')
    inner.tabIndex = 0
    outer.appendChild(inner)
    document.body.appendChild(outer)
    inner.focus()
    renderHook(() => useEscapeClose(onClose))
    pressEscape(inner)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('skips close while IME composition is active', () => {
    const onClose = vi.fn()
    renderHook(() => useEscapeClose(onClose))
    pressEscape(window, { isComposing: true })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('falls back to document.activeElement when event target is not an element', () => {
    const onClose = vi.fn()
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    renderHook(() => useEscapeClose(onClose))
    // Dispatch from window (target becomes window) while INPUT remains focused
    pressEscape()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('removes the listener on unmount', () => {
    const onClose = vi.fn()
    const { unmount } = renderHook(() => useEscapeClose(onClose))
    unmount()
    pressEscape()
    expect(onClose).not.toHaveBeenCalled()
  })

  // A non-text INPUT (range, checkbox, radio, button, submit, color) has
  // nothing Escape could discard — focus there must not block close.
  // Without this, dragging a zoom slider (an <input type="range">, e.g.
  // WordTimelineView's) made Escape dead for the whole modal.
  it.each(['range', 'checkbox', 'radio', 'button', 'submit', 'color'])(
    'does NOT skip close when a non-text <input type="%s"> is focused',
    (type) => {
      const onClose = vi.fn()
      const input = document.createElement('input')
      input.type = type
      document.body.appendChild(input)
      input.focus()
      renderHook(() => useEscapeClose(onClose))
      pressEscape(input)
      expect(onClose).toHaveBeenCalledTimes(1)
    },
  )

  it('still skips close when a text-like <input type="email"> is focused', () => {
    const onClose = vi.fn()
    const input = document.createElement('input')
    input.type = 'email'
    document.body.appendChild(input)
    input.focus()
    renderHook(() => useEscapeClose(onClose))
    pressEscape(input)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('useEscapeCloseCapture', () => {
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('skips close when a TEXTAREA is focused (default guardTypable)', () => {
    const onClose = vi.fn()
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()
    renderHook(() => useEscapeCloseCapture(onClose))
    pressEscape(textarea)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does NOT skip close when a range slider is focused (matches useEscapeClose)', () => {
    const onClose = vi.fn()
    const input = document.createElement('input')
    input.type = 'range'
    document.body.appendChild(input)
    input.focus()
    renderHook(() => useEscapeCloseCapture(onClose))
    pressEscape(input)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('guardTypable=false closes even from a focused TEXTAREA (JsonEditorModal: its only control)', () => {
    const onClose = vi.fn()
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()
    renderHook(() => useEscapeCloseCapture(onClose, true, false))
    pressEscape(textarea)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('guardTypable=false still skips close during IME composition', () => {
    const onClose = vi.fn()
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()
    renderHook(() => useEscapeCloseCapture(onClose, true, false))
    pressEscape(textarea, { isComposing: true })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('stops propagation to an outer bubble-phase useEscapeClose listener', () => {
    const onCloseInner = vi.fn()
    const onCloseOuter = vi.fn()
    renderHook(() => useEscapeClose(onCloseOuter))
    renderHook(() => useEscapeCloseCapture(onCloseInner))
    pressEscape(document.body)
    expect(onCloseInner).toHaveBeenCalledTimes(1)
    expect(onCloseOuter).not.toHaveBeenCalled()
  })
})

describe('useEscapeSwallow', () => {
  afterEach(() => {
    cleanup()
  })

  it('stops propagation so parent useEscapeClose never fires', () => {
    const onClose = vi.fn()
    renderHook(() => useEscapeClose(onClose))
    renderHook(() => useEscapeSwallow())
    // Dispatch on a descendant so the event traverses document (capture path)
    // before reaching window (bubble listener).
    pressEscape(document.body)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not install the listener when disabled', () => {
    const onClose = vi.fn()
    renderHook(() => useEscapeClose(onClose))
    renderHook(() => useEscapeSwallow(false))
    pressEscape(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
