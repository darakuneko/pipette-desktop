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

  // Enter-to-commit is wired at the picker level (TabbedKeycodes window
  // handler routes any Enter inside the picker container to onConfirm), not
  // at individual tiles — so TileGrids itself doesn't attach an onKeyDown.
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
})
