// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// The key picker's tab reorder mode inside a real TabbedKeycodes, with the
// saved order held by a test provider in place of useDevicePrefs.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useMemo, useState, type ComponentProps } from 'react'
import { TabbedKeycodes } from '../TabbedKeycodes'
import { KeycodeTabOrderContext } from '../keycode-tab-order-context'
import { LONG_PRESS_MS } from '../use-keycode-tab-reorder'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k} ${JSON.stringify(opts)}` : k),
  }),
}))

vi.mock('../../../hooks/useAppConfig', () => ({
  useAppConfig: () => ({ config: { defaultBasicViewType: 'list', defaultSplitKeyMode: 'flat' }, loading: false, set: vi.fn() }),
}))

// Basic keeps its keycode under maskOnly; the others are not basic.
vi.mock('../categories', () => ({
  KEYCODE_CATEGORIES: [
    { id: 'basic', labelKey: 'keycodes.basic', getKeycodes: () => [{ qmkId: 'KC_A', label: 'A', hidden: false }] },
    { id: 'layers', labelKey: 'keycodes.layers', getKeycodes: () => [{ qmkId: 'MO(1)', label: 'MO1', hidden: false }] },
    { id: 'midi', labelKey: 'keycodes.midi', getKeycodes: () => [{ qmkId: 'MI_C', label: 'C', hidden: true }] },
    { id: 'system', labelKey: 'keycodes.system', getKeycodes: () => [{ qmkId: 'QK_BOOT', label: 'Boot', hidden: false }] },
  ],
  groupByLayoutRow: () => [],
}))

vi.mock('../../../../shared/keycodes/keycodes', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../shared/keycodes/keycodes')>(),
  isBasic: (qmkId: string) => qmkId === 'KC_A',
}))

type PickerProps = ComponentProps<typeof TabbedKeycodes>

interface HostProps extends PickerProps {
  initial?: string[]
  onSave?: (order: string[] | undefined) => void
  scopeKey?: string
}

function Host({ initial, onSave, scopeKey = 'uid-1', ...props }: HostProps) {
  const [order, setOrderState] = useState(initial)
  const value = useMemo(() => ({
    order,
    setOrder: (next: string[] | undefined) => { onSave?.(next); setOrderState(next) },
    scopeKey,
  }), [order, onSave, scopeKey])
  return (
    <KeycodeTabOrderContext.Provider value={value}>
      <TabbedKeycodes tabReorder {...props} />
    </KeycodeTabOrderContext.Provider>
  )
}

function tab(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-keycode-tab="${id}"]`)
  if (!el) throw new Error(`no tab ${id}`)
  return el
}

function shownOrder(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-keycode-tab]')).map((el) => el.dataset.keycodeTab ?? '')
}

function selected(): string | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-keycode-tab]'))
    .find((el) => el.className.includes('border-b-accent'))?.dataset.keycodeTab
}

function inMode(): boolean {
  return screen.queryByTestId('keycode-tab-reorder-done') !== null
}

function longPress(id: string, ms = LONG_PRESS_MS): void {
  fireEvent.pointerDown(tab(id), { button: 0, clientX: 10, clientY: 10 })
  act(() => { vi.advanceTimersByTime(ms) })
  fireEvent.pointerUp(tab(id))
  fireEvent.click(tab(id))
}

function enterByKeyboard(id = 'basic'): void {
  tab(id).focus()
  fireEvent.keyDown(tab(id), { key: 'F10', shiftKey: true })
}

function drag(from: string, to: string, { drop = true } = {}): void {
  const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
  fireEvent.dragStart(tab(from), { dataTransfer })
  fireEvent.dragOver(tab(to), { dataTransfer })
  if (drop) fireEvent.drop(tab(to), { dataTransfer })
  fireEvent.dragEnd(tab(from), { dataTransfer })
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('TabbedKeycodes tab order', () => {
  it('shows the saved order in the tab bar; hidden and unknown ids are skipped', () => {
    render(<Host initial={['future', 'system', 'midi', 'layers']} />)
    expect(shownOrder()).toEqual(['system', 'layers', 'basic'])
  })

  it('pickers without tabReorder show the saved order but never enter the mode', () => {
    render(
      <KeycodeTabOrderContext.Provider value={{ order: ['system'], setOrder: vi.fn(), scopeKey: 'u' }}>
        <TabbedKeycodes />
      </KeycodeTabOrderContext.Provider>,
    )
    expect(shownOrder()).toEqual(['system', 'basic', 'layers'])
    longPress('system')
    enterByKeyboard('system')
    expect(inMode()).toBe(false)
  })

  it('keeps selection and the fallback tab in the canonical order', () => {
    const { rerender } = render(<Host initial={['layers', 'system']} keyboardPickerContent={<div>kb</div>} />)
    expect(selected()).toBe('basic')
    fireEvent.click(tab('keyboard'))
    expect(selected()).toBe('keyboard')
    rerender(<Host initial={['layers', 'system']} />)
    expect(selected()).toBe('basic')
  })
})

describe('entering the mode', () => {
  it('enters after a 500 ms long-press, and the release does not switch tabs', () => {
    const onTabChange = vi.fn()
    render(<Host onTabChange={onTabChange} />)
    longPress('system')
    expect(inMode()).toBe(true)
    expect(selected()).toBe('basic')
    expect(onTabChange).not.toHaveBeenCalled()
  })

  it('a 499 ms press is a normal click', () => {
    render(<Host />)
    longPress('system', LONG_PRESS_MS - 1)
    expect(inMode()).toBe(false)
    expect(selected()).toBe('system')
  })

  it.each([
    ['moving too far', (el: HTMLElement) => fireEvent.pointerMove(el, { clientX: 30, clientY: 10 })],
    ['pointercancel', (el: HTMLElement) => fireEvent.pointerCancel(el)],
    ['pointerleave', (el: HTMLElement) => fireEvent.pointerLeave(el)],
    ['window blur', () => fireEvent.blur(window)],
  ])('%s cancels a pending long-press', (_name, cancel) => {
    render(<Host />)
    fireEvent.pointerDown(tab('system'), { button: 0, clientX: 10, clientY: 10 })
    cancel(tab('system'))
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS) })
    expect(inMode()).toBe(false)
  })

  it('a small wobble does not cancel the long-press', () => {
    render(<Host />)
    fireEvent.pointerDown(tab('system'), { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(tab('system'), { clientX: 14, clientY: 13 })
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS) })
    expect(inMode()).toBe(true)
  })

  it('ignores a right-button press', () => {
    render(<Host />)
    fireEvent.pointerDown(tab('system'), { button: 2 })
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS) })
    expect(inMode()).toBe(false)
  })

  it('clears the pending timer on unmount', () => {
    const { unmount } = render(<Host />)
    fireEvent.pointerDown(tab('system'), { button: 0 })
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['Shift+F10', { key: 'F10', shiftKey: true }],
    ['ContextMenu', { key: 'ContextMenu' }],
  ])('%s on a focused tab enters the mode and keeps the focus', (_name, init) => {
    render(<Host />)
    tab('layers').focus()
    fireEvent.keyDown(tab('layers'), init)
    expect(inMode()).toBe(true)
    expect(document.activeElement).toBe(tab('layers'))
  })
})

describe('in the mode', () => {
  it('clicking a tab does not switch tabs', () => {
    const onTabChange = vi.fn()
    render(<Host onTabChange={onTabChange} />)
    enterByKeyboard()
    fireEvent.click(tab('system'))
    expect(selected()).toBe('basic')
    expect(onTabChange).not.toHaveBeenCalled()
  })

  it('←/→ moves the focused tab by one, saves each move once and keeps the focus', () => {
    const onSave = vi.fn()
    const onTabChange = vi.fn()
    render(<Host onSave={onSave} onTabChange={onTabChange} />)
    enterByKeyboard('basic')
    fireEvent.keyDown(tab('basic'), { key: 'ArrowRight' })
    expect(shownOrder()).toEqual(['layers', 'basic', 'system'])
    expect(document.activeElement).toBe(tab('basic'))
    fireEvent.keyDown(tab('basic'), { key: 'ArrowRight' })
    expect(shownOrder()).toEqual(['layers', 'system', 'basic'])
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/editor\.keymap\.tabReorder\.moved.*"position":3,"total":3/)).toBeInTheDocument()
    // At the end: nothing to save.
    fireEvent.keyDown(tab('basic'), { key: 'ArrowRight' })
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(onTabChange).not.toHaveBeenCalled()
    expect(selected()).toBe('basic')
  })

  it('saves the full order: hidden (MIDI) and unknown ids keep their slots', () => {
    const onSave = vi.fn()
    render(<Host initial={['future', 'midi', 'basic', 'layers', 'system']} onSave={onSave} />)
    enterByKeyboard('system')
    fireEvent.keyDown(tab('system'), { key: 'ArrowLeft' })
    expect(onSave).toHaveBeenLastCalledWith(['future', 'midi', 'basic', 'system', 'layers', 'keyboard'])
  })

  it('moves the Keyboard tab like any other', () => {
    const onSave = vi.fn()
    render(<Host onSave={onSave} keyboardPickerContent={<div>kb</div>} />)
    enterByKeyboard('keyboard')
    fireEvent.keyDown(tab('keyboard'), { key: 'ArrowLeft' })
    expect(shownOrder()).toEqual(['basic', 'layers', 'keyboard', 'system'])
    expect(onSave.mock.calls[0][0]).toEqual(['basic', 'layers', 'midi', 'keyboard', 'system'])
  })

  it('a drop on a tab saves once; the drag end that follows does not save again', () => {
    const onSave = vi.fn()
    render(<Host onSave={onSave} />)
    enterByKeyboard()
    drag('system', 'basic')
    expect(shownOrder()).toEqual(['system', 'basic', 'layers'])
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('a cancelled or outside drop and a drop on the same place save nothing', () => {
    const onSave = vi.fn()
    render(<Host onSave={onSave} />)
    enterByKeyboard()
    drag('system', 'basic', { drop: false })
    drag('layers', 'layers')
    expect(onSave).not.toHaveBeenCalled()
    expect(shownOrder()).toEqual(['basic', 'layers', 'system'])
  })

  it('tabs are not draggable outside the mode', () => {
    render(<Host />)
    expect(tab('basic').getAttribute('draggable')).toBe('false')
    enterByKeyboard()
    expect(tab('basic').getAttribute('draggable')).toBe('true')
  })

  it('Reset restores the default order and clears the saved one', () => {
    const onSave = vi.fn()
    render(<Host initial={['system', 'layers']} onSave={onSave} />)
    enterByKeyboard('system')
    fireEvent.click(screen.getByTestId('keycode-tab-reorder-reset'))
    expect(onSave).toHaveBeenCalledWith(undefined)
    expect(shownOrder()).toEqual(['basic', 'layers', 'system'])
    expect(screen.getByTestId('keycode-tab-reorder-reset')).toBeDisabled()
    expect(inMode()).toBe(true)
  })

  it('drops a drag when the order is replaced from outside', () => {
    const onSave = vi.fn()
    function ExternalHost() {
      const [order, setOrder] = useState<string[] | undefined>(undefined)
      const value = useMemo(() => ({ order, setOrder: (next: string[] | undefined) => { onSave(next); setOrder(next) }, scopeKey: 'u' }), [order])
      return (
        <KeycodeTabOrderContext.Provider value={value}>
          <button type="button" onClick={() => setOrder(['layers'])}>replace</button>
          <TabbedKeycodes tabReorder />
        </KeycodeTabOrderContext.Provider>
      )
    }
    render(<ExternalHost />)
    enterByKeyboard()
    const dataTransfer = { setData: vi.fn() }
    fireEvent.dragStart(tab('system'), { dataTransfer })
    act(() => { screen.getByText('replace').click() })
    fireEvent.drop(tab('basic'), { dataTransfer })
    expect(onSave).not.toHaveBeenCalled()
    expect(shownOrder()).toEqual(['layers', 'basic', 'system'])
  })

  it('the LM modifier picker has one tab and nothing to save', () => {
    const onSave = vi.fn()
    render(<Host onSave={onSave} lmMode />)
    expect(shownOrder()).toEqual(['lm-mods'])
    enterByKeyboard('lm-mods')
    fireEvent.keyDown(tab('lm-mods'), { key: 'ArrowLeft' })
    fireEvent.keyDown(tab('lm-mods'), { key: 'ArrowRight' })
    expect(onSave).not.toHaveBeenCalled()
  })

  it('closes when the keyboard changes', () => {
    const { rerender } = render(<Host scopeKey="uid-1" />)
    enterByKeyboard()
    rerender(<Host scopeKey="uid-2" />)
    expect(inMode()).toBe(false)
  })
})

describe('leaving the mode', () => {
  it.each(['Enter', 'Escape'])('%s leaves the mode and keeps saved moves', (key) => {
    const onSave = vi.fn()
    render(<Host onSave={onSave} />)
    enterByKeyboard('basic')
    fireEvent.keyDown(tab('basic'), { key: 'ArrowRight' })
    fireEvent.keyDown(tab('basic'), { key })
    expect(inMode()).toBe(false)
    expect(shownOrder()).toEqual(['layers', 'basic', 'system'])
  })

  it('Done leaves the mode', () => {
    render(<Host />)
    enterByKeyboard()
    fireEvent.click(screen.getByTestId('keycode-tab-reorder-done'))
    expect(inMode()).toBe(false)
  })

  it('Enter on a focused Reset button resets instead of leaving', () => {
    const onSave = vi.fn()
    render(<Host initial={['system']} onSave={onSave} />)
    enterByKeyboard()
    const reset = screen.getByTestId('keycode-tab-reorder-reset')
    reset.focus()
    fireEvent.keyDown(reset, { key: 'Enter' })
    expect(onSave).toHaveBeenCalledWith(undefined)
    expect(inMode()).toBe(true)
  })

  it('Escape during a drag cancels the drag first', () => {
    render(<Host />)
    enterByKeyboard()
    fireEvent.dragStart(tab('system'), { dataTransfer: { setData: vi.fn() } })
    expect(tab('system').className).toContain('opacity-50')
    fireEvent.keyDown(tab('system'), { key: 'Escape' })
    expect(tab('system').className).not.toContain('opacity-50')
    expect(inMode()).toBe(true)
    fireEvent.keyDown(tab('system'), { key: 'Escape' })
    expect(inMode()).toBe(false)
  })

  it('a pointerdown outside the tab bar leaves; the Reset / Done row counts as inside', () => {
    render(<><Host /><button type="button">outside</button></>)
    enterByKeyboard()
    fireEvent.pointerDown(screen.getByTestId('keycode-tab-reorder-reset'))
    fireEvent.pointerDown(tab('layers'))
    expect(inMode()).toBe(true)
    fireEvent.pointerDown(screen.getByText('outside'))
    expect(inMode()).toBe(false)
  })

  it('consumes Enter before the picker confirms, and lets it through after', () => {
    const onConfirm = vi.fn()
    render(<Host onConfirm={onConfirm} />)
    enterByKeyboard()
    fireEvent.keyDown(tab('basic'), { key: 'Enter' })
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.keyDown(tab('basic'), { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('consumes Escape before other window handlers', () => {
    const seen: string[] = []
    const onKey = (e: KeyboardEvent): void => { seen.push(e.key) }
    window.addEventListener('keydown', onKey)
    render(<Host />)
    enterByKeyboard()
    fireEvent.keyDown(tab('basic'), { key: 'Escape' })
    window.removeEventListener('keydown', onKey)
    expect(seen).not.toContain('Escape')
  })

  it('does not take Enter during IME composition', () => {
    render(<Host />)
    enterByKeyboard()
    fireEvent.keyDown(tab('basic'), { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(inMode()).toBe(true)
  })

  it('leaves without taking the key when a modal covers the bar', () => {
    const seen: string[] = []
    const onKey = (e: KeyboardEvent): void => { seen.push(e.key) }
    window.addEventListener('keydown', onKey)
    const overlay = document.createElement('div')
    document.body.appendChild(overlay)
    render(<Host />)
    enterByKeyboard()
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => overlay })
    fireEvent.keyDown(tab('basic'), { key: 'Enter' })
    window.removeEventListener('keydown', onKey)
    delete (document as { elementFromPoint?: unknown }).elementFromPoint
    overlay.remove()
    expect(seen).toContain('Enter')
    expect(inMode()).toBe(false)
  })

  it('leaves when a modal opens on top', async () => {
    render(<Host />)
    enterByKeyboard()
    const overlay = document.createElement('div')
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => overlay })
    await act(async () => {
      document.body.appendChild(overlay)
      await Promise.resolve()
      vi.advanceTimersToNextFrame()
    })
    delete (document as { elementFromPoint?: unknown }).elementFromPoint
    overlay.remove()
    expect(inMode()).toBe(false)
  })

  it('checks the cover once per frame however many mutation batches arrive', async () => {
    render(<Host />)
    enterByKeyboard()
    const elementFromPoint = vi.fn(() => null)
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: elementFromPoint })
    const nodes: HTMLElement[] = []
    await act(async () => {
      for (let i = 0; i < 3; i++) {
        const node = document.createElement('div')
        nodes.push(node)
        document.body.appendChild(node)
        await Promise.resolve()
      }
    })
    expect(elementFromPoint).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersToNextFrame() })
    delete (document as { elementFromPoint?: unknown }).elementFromPoint
    for (const node of nodes) node.remove()
    expect(elementFromPoint).toHaveBeenCalledTimes(1)
    expect(inMode()).toBe(true)
  })
})
