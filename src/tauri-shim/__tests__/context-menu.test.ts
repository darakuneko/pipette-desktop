// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// Right-clicking keeps the webview's menu on editable text only.

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { suppressContextMenuOutsideEditables } from '../context-menu'

beforeAll(() => {
  suppressContextMenuOutsideEditables(document)
})

afterEach(() => {
  document.body.replaceChildren()
})

function rightClick(target: Element): boolean {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

function add<T extends HTMLElement>(html: string): T {
  const template = document.createElement('template')
  template.innerHTML = html
  const element = template.content.firstElementChild as T
  document.body.append(element)
  return element
}

describe('suppressContextMenuOutsideEditables', () => {
  it.each([
    '<input>',
    '<input type="text">',
    '<input type="search">',
    '<input type="email">',
    '<input type="url">',
    '<input type="tel">',
    '<input type="password">',
    '<input type="number">',
    '<textarea></textarea>',
  ])('keeps the menu on %s', (html) => {
    expect(rightClick(add(html))).toBe(false)
  })

  it('keeps the menu inside contenteditable content', () => {
    const editor = add('<div contenteditable="true"><span>text</span></div>')
    const span = editor.querySelector('span') as HTMLElement
    // jsdom does not compute isContentEditable.
    Object.defineProperty(span, 'isContentEditable', { value: true })
    expect(rightClick(span)).toBe(false)
  })

  it.each([
    '<div>plain text</div>',
    '<p><span>nested text</span></p>',
    '<button>button</button>',
    '<a href="https://example.com/">link</a>',
    '<img alt="">',
    '<input type="checkbox">',
    '<input type="range">',
    '<input type="button" value="b">',
    '<input readonly>',
    '<input disabled>',
    '<textarea readonly></textarea>',
    '<select><option>o</option></select>',
  ])('suppresses the menu on %s', (html) => {
    const element = add(html)
    expect(rightClick(element.querySelector('span') ?? element)).toBe(true)
  })

  it('suppresses the menu on the document itself', () => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('suppresses the menu even when the page stops the event', () => {
    const element = add('<div>plain text</div>')
    element.addEventListener('contextmenu', (event) => event.stopPropagation())
    expect(rightClick(element)).toBe(true)
  })

  it('leaves the event to the page otherwise', () => {
    const element = add('<div>plain text</div>')
    let seen = false
    element.addEventListener('contextmenu', () => {
      seen = true
    })
    rightClick(element)
    expect(seen).toBe(true)
  })
})
