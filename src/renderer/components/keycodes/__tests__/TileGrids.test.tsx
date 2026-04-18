// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TdTileGrid, MacroTileGrid } from '../TileGrids'
import type { TapDanceEntry } from '../../../../shared/types/protocol'
import type { MacroAction } from '../../../../preload/macro'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  findKeycode: (id: string) => ({ qmkId: id, label: id, masked: false, hidden: false }),
  codeToLabel: (code: number) => `code-${code}`,
}))

function tdEntry(overrides: Partial<TapDanceEntry> = {}): TapDanceEntry {
  return { onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200, ...overrides }
}

describe('TdTileGrid', () => {
  const entries: TapDanceEntry[] = [tdEntry({ onTap: 0x04 }), tdEntry()]

  it('fires onSelect with TD(i) on single click', () => {
    const onSelect = vi.fn()
    render(<TdTileGrid entries={entries} onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId('td-tile-1'))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ qmkId: 'TD(1)' }))
  })

  it('fires onDoubleClick with TD(i) on double click', () => {
    const onSelect = vi.fn()
    const onDoubleClick = vi.fn()
    render(<TdTileGrid entries={entries} onSelect={onSelect} onDoubleClick={onDoubleClick} />)
    fireEvent.doubleClick(screen.getByTestId('td-tile-0'))
    expect(onDoubleClick).toHaveBeenCalledWith(expect.objectContaining({ qmkId: 'TD(0)' }))
  })

  it('fires onDoubleClick with TD(i) on Enter keydown', () => {
    const onSelect = vi.fn()
    const onDoubleClick = vi.fn()
    render(<TdTileGrid entries={entries} onSelect={onSelect} onDoubleClick={onDoubleClick} />)
    fireEvent.keyDown(screen.getByTestId('td-tile-1'), { key: 'Enter' })
    expect(onDoubleClick).toHaveBeenCalledWith(expect.objectContaining({ qmkId: 'TD(1)' }))
  })

  it('ignores non-Enter keys', () => {
    const onDoubleClick = vi.fn()
    render(<TdTileGrid entries={entries} onSelect={vi.fn()} onDoubleClick={onDoubleClick} />)
    fireEvent.keyDown(screen.getByTestId('td-tile-0'), { key: 'a' })
    expect(onDoubleClick).not.toHaveBeenCalled()
  })

  it('falls back to native Enter→click when onDoubleClick is omitted', () => {
    const onSelect = vi.fn()
    render(<TdTileGrid entries={entries} onSelect={onSelect} />)
    // Without onDoubleClick, onKeyDown is not attached, so Enter fires the
    // browser default button activation (click event → onSelect).
    const tile = screen.getByTestId('td-tile-0')
    fireEvent.keyDown(tile, { key: 'Enter' })
    fireEvent.click(tile) // native activation that would follow
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ qmkId: 'TD(0)' }))
  })
})

describe('MacroTileGrid', () => {
  const macros: MacroAction[][] = [
    [{ type: 'tap', keycodes: [0x04] }],
    [],
  ]

  it('fires onSelect with M{i} on single click', () => {
    const onSelect = vi.fn()
    render(<MacroTileGrid macros={macros} onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId('macro-tile-0'))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ qmkId: 'M0' }))
  })

  it('fires onDoubleClick with M{i} on double click', () => {
    const onDoubleClick = vi.fn()
    render(<MacroTileGrid macros={macros} onSelect={vi.fn()} onDoubleClick={onDoubleClick} />)
    fireEvent.doubleClick(screen.getByTestId('macro-tile-1'))
    expect(onDoubleClick).toHaveBeenCalledWith(expect.objectContaining({ qmkId: 'M1' }))
  })

  it('fires onDoubleClick with M{i} on Enter keydown', () => {
    const onDoubleClick = vi.fn()
    render(<MacroTileGrid macros={macros} onSelect={vi.fn()} onDoubleClick={onDoubleClick} />)
    fireEvent.keyDown(screen.getByTestId('macro-tile-0'), { key: 'Enter' })
    expect(onDoubleClick).toHaveBeenCalledWith(expect.objectContaining({ qmkId: 'M0' }))
  })
})
