// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { KEYCODE_CATEGORIES } from '../categories'
import { defaultTabOrder, moveVisible, projectVisible, resolveFullOrder, sameOrder } from '../keycode-tab-order'

describe('defaultTabOrder', () => {
  it('lists the real category ids (MIDI included) followed by the keyboard tab', () => {
    const order = defaultTabOrder()
    expect(order).toEqual([...KEYCODE_CATEGORIES.map((c) => c.id), 'keyboard'])
    expect(order).toContain('midi')
    expect(order).not.toContain('lm-mods')
  })
})

describe('resolveFullOrder', () => {
  it('is the default order when nothing is saved', () => {
    expect(resolveFullOrder(undefined)).toEqual(defaultTabOrder())
  })

  it('keeps the saved order, drops repeats and appends missing ids in default order', () => {
    const full = resolveFullOrder(['user', 'basic', 'user', 'keyboard'])
    const rest = defaultTabOrder().filter((id) => !['user', 'basic', 'keyboard'].includes(id))
    expect(full).toEqual(['user', 'basic', 'keyboard', ...rest])
  })

  it('keeps ids this client does not know where they were saved', () => {
    const full = resolveFullOrder(['future', 'basic'])
    expect(full.slice(0, 2)).toEqual(['future', 'basic'])
  })
})

describe('projectVisible', () => {
  it('sorts the visible ids by the full order and ignores hidden and unknown ids', () => {
    expect(projectVisible(['basic', 'layers', 'user'], ['future', 'user', 'midi', 'basic', 'layers']))
      .toEqual(['user', 'basic', 'layers'])
  })

  it('puts ids missing from the full order (the LM modifier tab) last, in their own order', () => {
    expect(projectVisible(['lm-mods', 'basic', 'x'], ['basic'])).toEqual(['basic', 'lm-mods', 'x'])
  })
})

describe('moveVisible', () => {
  const full = ['a', 'H', 'b', 'c', 'F']
  const visible = ['a', 'b', 'c']

  it('moves within the visible tabs and keeps hidden / unknown ids in their slots', () => {
    expect(moveVisible(full, visible, 'c', 0)).toEqual(['c', 'H', 'a', 'b', 'F'])
    expect(moveVisible(full, visible, 'a', 2)).toEqual(['b', 'H', 'c', 'a', 'F'])
    expect(moveVisible(full, visible, 'b', 0)).toEqual(['b', 'H', 'a', 'c', 'F'])
  })

  it('returns an equal copy for a no-op or out-of-range move', () => {
    expect(moveVisible(full, visible, 'b', 1)).toEqual(full)
    expect(moveVisible(full, visible, 'b', 1)).not.toBe(full)
    expect(moveVisible(full, visible, 'b', -1)).toEqual(full)
    expect(moveVisible(full, visible, 'b', 3)).toEqual(full)
    expect(moveVisible(full, visible, 'missing', 0)).toEqual(full)
    // An id outside the full order (the LM modifier tab) is never written.
    expect(moveVisible(['a', 'b'], ['a', 'b', 'lm-mods'], 'lm-mods', 0)).toEqual(['a', 'b'])
  })

  it('applies consecutive moves on top of each other', () => {
    let order = full
    order = moveVisible(order, projectVisible(visible, order), 'c', 1)
    order = moveVisible(order, projectVisible(visible, order), 'c', 0)
    expect(projectVisible(visible, order)).toEqual(['c', 'a', 'b'])
  })
})

describe('sameOrder', () => {
  it('compares element by element', () => {
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameOrder(['a'], ['a', 'b'])).toBe(false)
  })
})
