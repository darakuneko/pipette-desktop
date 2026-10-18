// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// The in-page actions and reads of one element: Playwright's `fill`, the
// text, value and box reads, and the forced double click.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchDoubleClick, fillElement, readElement } from '../page-element'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('fillElement', () => {
  it('sets the value through the element setter and sends input and change', () => {
    document.body.innerHTML = '<input id="a" type="number" value="200">'
    const input = document.getElementById('a') as HTMLInputElement
    const events: string[] = []
    input.addEventListener('input', () => events.push(`input:${input.value}`))
    input.addEventListener('change', () => events.push(`change:${input.value}`))
    const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set')

    expect(fillElement('#a', '210')).toBeNull()
    expect(input.value).toBe('210')
    expect(setter).toHaveBeenCalledWith('210')
    expect(events).toEqual(['input:210', 'change:210'])
    expect(document.activeElement).toBe(input)
    setter.mockRestore()
  })

  it('fills a textarea, and refuses other elements and read-only or disabled fields', () => {
    document.body.innerHTML = `
      <textarea id="t"></textarea>
      <div id="d"></div>
      <input id="r" readonly>
      <input id="x" disabled>`
    expect(fillElement('#t', 'two\nlines')).toBeNull()
    expect((document.getElementById('t') as HTMLTextAreaElement).value).toBe('two\nlines')
    expect(fillElement('#d', 'x')).toBe('not an input or textarea')
    expect(fillElement('#missing', 'x')).toBe('not an input or textarea')
    expect(fillElement('#r', 'x')).toBe('not editable')
    expect(fillElement('#x', 'x')).toBe('not editable')
  })
})

describe('readElement', () => {
  it('reads the text content and the value of a form field', () => {
    document.body.innerHTML = `
      <p id="p">Saved <b>now</b></p>
      <input id="i" value="42">
      <select id="s"><option value="a">A</option><option value="b" selected>B</option></select>`
    expect(readElement('#p', 'text')).toBe('Saved now')
    expect(readElement('#i', 'value')).toBe('42')
    expect(readElement('#s', 'value')).toBe('b')
    expect(readElement('#p', 'value')).toBe('')
    expect(readElement('#missing', 'text')).toBeNull()
  })

  it('reads the box in the viewport, null for an element without size', () => {
    document.body.innerHTML = '<div id="b"></div><div id="e"></div>'
    const sized = document.getElementById('b') as HTMLElement
    sized.getBoundingClientRect = () => ({ x: 5, y: 6, width: 70, height: 20, top: 6, left: 5, right: 75, bottom: 26, toJSON: () => ({}) })
    expect(readElement('#b', 'box')).toEqual({ x: 5, y: 6, width: 70, height: 20 })
    expect(readElement('#e', 'box')).toBeNull()
  })
})

describe('dispatchDoubleClick', () => {
  it('sends a bubbling dblclick, and answers false for no element', () => {
    document.body.innerHTML = '<svg><g id="k" data-key-pos="0,0"><rect></rect></g></svg>'
    const seen: string[] = []
    document.body.addEventListener('dblclick', (event) => seen.push((event.target as Element).id))
    expect(dispatchDoubleClick('#k')).toBe(true)
    expect(seen).toEqual(['k'])
    expect(dispatchDoubleClick('#missing')).toBe(false)
  })
})
