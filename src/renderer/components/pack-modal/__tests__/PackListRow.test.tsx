// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PackListRow } from '../PackListRow'

describe('PackListRow', () => {
  describe('stacked shape (Language Packs / Theme Packs)', () => {
    it('renders leadingControl, name, columns, actions and the badge/hubActions second line', () => {
      render(
        <PackListRow
          testid="row-1"
          leadingControl={<span data-testid="leading">L</span>}
          name={<span data-testid="name">Pack Name</span>}
          columns={<span data-testid="col">v1.0</span>}
          actions={<span data-testid="actions">Export Delete</span>}
          badge={<span data-testid="badge">Saved</span>}
          hubActions={<span data-testid="hub-actions">Upload</span>}
        />,
      )
      expect(screen.getByTestId('row-1')).toBeTruthy()
      expect(screen.getByTestId('leading')).toBeTruthy()
      expect(screen.getByTestId('name')).toBeTruthy()
      expect(screen.getByTestId('col')).toBeTruthy()
      expect(screen.getByTestId('actions')).toBeTruthy()
      expect(screen.getByTestId('badge')).toBeTruthy()
      expect(screen.getByTestId('hub-actions')).toBeTruthy()
    })

    it('applies the active border class only when active', () => {
      const { rerender } = render(
        <PackListRow testid="row-active" name="N" actions={null} active />,
      )
      expect(screen.getByTestId('row-active').className).toContain('border-accent')
      rerender(<PackListRow testid="row-active" name="N" actions={null} active={false} />)
      expect(screen.getByTestId('row-active').className).toContain('border-edge')
      expect(screen.getByTestId('row-active').className).not.toContain('border-accent')
    })

    it('does not attach drag handlers in the stacked shape', () => {
      const onDragStart = vi.fn()
      render(<PackListRow testid="row-nodrag" name="N" actions={null} onDragStart={onDragStart} />)
      const row = screen.getByTestId('row-nodrag')
      expect(row.getAttribute('draggable')).toBeNull()
    })
  })

  describe('sideColumn shape (Key Labels)', () => {
    it('renders sideColumn, name, columns, actions and the raw secondLine content', () => {
      render(
        <PackListRow
          testid="row-2"
          shape="sideColumn"
          sideColumn={<span data-testid="grip">grip</span>}
          name={<span data-testid="name-2">Label Name</span>}
          columns={<span data-testid="col-2">Author</span>}
          actions={<span data-testid="actions-2">Delete</span>}
          secondLine={<div data-testid="second-line">custom hub line</div>}
        />,
      )
      expect(screen.getByTestId('row-2')).toBeTruthy()
      expect(screen.getByTestId('grip')).toBeTruthy()
      expect(screen.getByTestId('name-2')).toBeTruthy()
      expect(screen.getByTestId('col-2')).toBeTruthy()
      expect(screen.getByTestId('actions-2')).toBeTruthy()
      expect(screen.getByTestId('second-line')).toBeTruthy()
    })

    it('wires drag handlers when draggable is set', () => {
      const onDragStart = vi.fn()
      const onDragOver = vi.fn()
      const onDragEnd = vi.fn()
      render(
        <PackListRow
          testid="row-drag"
          shape="sideColumn"
          draggable
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          sideColumn={<span>grip</span>}
          name="N"
          actions={null}
        />,
      )
      const row = screen.getByTestId('row-drag')
      expect(row.getAttribute('draggable')).toBe('true')
      fireEvent.dragStart(row, { dataTransfer: { effectAllowed: '', setData: vi.fn() } })
      expect(onDragStart).toHaveBeenCalled()
      fireEvent.dragOver(row)
      expect(onDragOver).toHaveBeenCalled()
      fireEvent.dragEnd(row)
      expect(onDragEnd).toHaveBeenCalled()
    })

    it('does not wire drag handlers when draggable is false', () => {
      const onDragOver = vi.fn()
      render(
        <PackListRow
          testid="row-nodrag-2"
          shape="sideColumn"
          onDragOver={onDragOver}
          sideColumn={<span>grip</span>}
          name="N"
          actions={null}
        />,
      )
      const row = screen.getByTestId('row-nodrag-2')
      expect(row.getAttribute('draggable')).toBeNull()
      fireEvent.dragOver(row)
      expect(onDragOver).not.toHaveBeenCalled()
    })

    it('wraps name in the same text-sm font-medium treatment as the stacked shape (regression: Key Labels rendered names in the ambient/default weight)', () => {
      render(
        <PackListRow
          testid="row-name-weight"
          shape="sideColumn"
          sideColumn={<span>grip</span>}
          name={<span data-testid="name-weight">Label Name</span>}
          actions={null}
        />,
      )
      const nameWrapper = screen.getByTestId('name-weight').parentElement
      expect(nameWrapper?.className).toContain('text-sm')
      expect(nameWrapper?.className).toContain('font-medium')
    })
  })
})
