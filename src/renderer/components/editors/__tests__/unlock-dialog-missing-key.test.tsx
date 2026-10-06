// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { UnlockDialog } from '../UnlockDialog'
import type { KleKey } from '../../../../shared/kle/types'
import { makeKey } from '../../keyboard/__tests__/kle-test-keys'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'unlock.progress' && opts) return `${opts.current}/${opts.total}`
      if (key === 'unlock.missingKeys' && opts) return `Missing unlock keys: ${opts.positions}`
      return key
    },
  }),
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  keycodeLabel: (kc: string) => kc,
  isMask: () => false,
  findOuterKeycode: () => null,
  findInnerKeycode: () => null,
  isModifiableKeycode: () => false,
  extractModMask: () => 0,
  extractBasicKey: (code: number) => code & 0xff,
  buildModMaskKeycode: (mask: number, key: number) => (mask << 8) | key,
  findKeycode: (qmkId: string) => ({ qmkId, label: qmkId }),
}))

const HIGHLIGHT_FILL = 'var(--accent-alt)'

const at = (row: number, col: number, o: Partial<KleKey> = {}) => makeKey({ row, col, x: col, y: row, ...o })
const opt = (row: number, col: number, layoutIndex: number, layoutOption: number) =>
  at(row, col, { layoutIndex, layoutOption })

function renderedAt(pos: string): Element[] {
  return Array.from(document.querySelectorAll(`[data-key-pos="${pos}"]`))
}

function isHighlighted(pos: string): boolean {
  const els = renderedAt(pos)
  return els.length > 0 && els.every((el) => el.querySelector('rect')?.getAttribute('fill') === HIGHLIGHT_FILL)
}

function warning(): HTMLElement | null {
  return screen.queryByTestId('unlock-missing-keys')
}

function dialog(keys: KleKey[], unlockKeys: [number, number][], layoutOptions?: Map<number, number>) {
  return (
    <UnlockDialog
      keys={keys}
      unlockKeys={unlockKeys}
      layoutOptions={layoutOptions}
      unlockStart={vi.fn().mockResolvedValue(undefined)}
      unlockPoll={vi.fn().mockResolvedValue([0, 1, 50])}
      onComplete={() => {}}
    />
  )
}

async function renderWith(keys: KleKey[], unlockKeys: [number, number][], layoutOptions?: Map<number, number>) {
  let result!: ReturnType<typeof render>
  await act(async () => { result = render(dialog(keys, unlockKeys, layoutOptions)) })
  return result
}

describe('UnlockDialog unlock keys outside the visible layout', () => {
  it('warns about unlock positions that are not in the layout', async () => {
    await renderWith([at(0, 0), at(0, 1)], [[0, 0], [2, 5], [0, 13]])
    const el = warning()
    expect(el).toHaveAttribute('role', 'status')
    expect(el?.textContent).toBe('Missing unlock keys: (2, 5), (0, 13)')
    expect(isHighlighted('0,0')).toBe(true)
  })

  it('shows no warning and keeps the selected options when every unlock key is visible', async () => {
    const keys = [at(0, 0), opt(1, 0, 0, 0), opt(1, 1, 0, 1)]
    await renderWith(keys, [[0, 0], [1, 0]], new Map([[0, 0]]))
    expect(isHighlighted('1,0')).toBe(true)
    expect(renderedAt('1,1')).toHaveLength(0)
    expect(warning()).toBeNull()
  })

  it('draws a hidden unlock key highlighted by swapping its group', async () => {
    const keys = [
      at(0, 0),
      opt(1, 0, 0, 0), opt(1, 1, 0, 0),
      opt(1, 2, 0, 1), opt(1, 3, 0, 1),
    ]
    await renderWith(keys, [[0, 0], [1, 3]], new Map([[0, 0]]))
    expect(renderedAt('1,0')).toHaveLength(0)
    expect(renderedAt('1,1')).toHaveLength(0)
    expect(renderedAt('1,2')).toHaveLength(1)
    expect(isHighlighted('1,3')).toBe(true)
    expect(warning()).toBeNull()
  })

  it('drops the override once no unlock key is hidden', async () => {
    const keys = [at(0, 0), opt(1, 0, 0, 0), opt(1, 1, 0, 1)]
    const opts = new Map([[0, 0]])
    const { rerender } = await renderWith(keys, [[0, 0], [1, 1]], opts)
    expect(renderedAt('1,1')).toHaveLength(1)
    expect(renderedAt('1,0')).toHaveLength(0)
    await act(async () => { rerender(dialog(keys, [[0, 0]], opts)) })
    expect(renderedAt('1,0')).toHaveLength(1)
    expect(renderedAt('1,1')).toHaveLength(0)
  })
})
