// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// Right-clicking keeps the webview's menu on editable text only.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installContextMenuPolicy, suppressContextMenuOutsideEditables } from '../context-menu'

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
    '<input type="date">',
    '<input type="time">',
    '<input type="datetime-local">',
    '<input type="month">',
    '<input type="week">',
    '<textarea></textarea>',
    '<select><option>o</option></select>',
  ])('keeps the menu on %s', (html) => {
    expect(rightClick(add(html))).toBe(false)
  })

  it.each(['', 'true', 'plaintext-only'])('keeps the menu inside contenteditable="%s" content', (value) => {
    const editor = add(`<div contenteditable="${value}"><span>text</span></div>`)
    expect(rightClick(editor.querySelector('span') as HTMLElement)).toBe(false)
  })

  it('suppresses the menu inside a contenteditable="false" part of editable content', () => {
    const editor = add('<div contenteditable="true"><p contenteditable="false"><span>fixed</span></p></div>')
    expect(rightClick(editor.querySelector('span') as HTMLElement)).toBe(true)
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
    '<select disabled><option>o</option></select>',
    '<input type="color">',
    '<input type="file">',
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

describe('installContextMenuPolicy', () => {
  function fakeWindow(extra: Record<string, unknown>): { win: Window; addEventListener: ReturnType<typeof vi.fn> } {
    const addEventListener = vi.fn()
    const win = { document: { addEventListener }, ...extra } as unknown as Window
    return { win, addEventListener }
  }

  it('suppresses the menu in builds without the development tools', () => {
    const { win, addEventListener } = fakeWindow({})
    installContextMenuPolicy(win)
    expect(addEventListener).toHaveBeenCalledWith('contextmenu', expect.any(Function), { capture: true })
  })

  it('keeps the webview menu in builds with the development tools', () => {
    const { win, addEventListener } = fakeWindow({ __PIPETTE_DEV_TOOLS__: true })
    installContextMenuPolicy(win)
    expect(addEventListener).not.toHaveBeenCalled()
  })
})
