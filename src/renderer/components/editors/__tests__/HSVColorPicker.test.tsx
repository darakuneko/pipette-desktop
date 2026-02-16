// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { HSVColorPicker } from '../HSVColorPicker'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'editor.lighting.colorPicker.palette': 'Palette',
        'editor.lighting.colorPicker.hsv': 'HSV',
      }
      return map[key] ?? key
    },
  }),
}))

function renderPicker(overrides: Partial<React.ComponentProps<typeof HSVColorPicker>> = {}) {
  const defaultProps = {
    hue: 0,
    saturation: 255,
    value: 255,
    onHueChange: vi.fn(),
    onSaturationChange: vi.fn(),
    onValueChange: vi.fn(),
    onColorChange: vi.fn(),
    ...overrides,
  }
  return { ...render(<HSVColorPicker {...defaultProps} />), props: defaultProps }
}

function getPaletteCells(): NodeListOf<Element> {
  return screen.getByTestId('palette-grid').querySelectorAll('[data-testid="palette-cell"]')
}

function getCellHsv(cell: Element): [number, number, number] {
  const [h, s, v] = cell.getAttribute('data-hsv')!.split(',').map(Number)
  return [h, s, v]
}

function getSelectedCell(): Element {
  const grid = screen.getByTestId('palette-grid')
  const selected = grid.querySelectorAll('[data-selected="true"]')
  expect(selected).toHaveLength(1)
  return selected[0]
}

describe('HSVColorPicker', () => {
  it('renders in palette mode by default', () => {
    renderPicker()
    expect(screen.getByTestId('palette-grid')).toBeInTheDocument()
    expect(screen.queryByTestId('sv-picker')).not.toBeInTheDocument()
  })

  it('palette grid contains 100 cells', () => {
    renderPicker()
    expect(getPaletteCells()).toHaveLength(100)
  })

  it('switches to HSV mode when HSV button is clicked', () => {
    renderPicker()
    fireEvent.click(screen.getByText('HSV'))
    expect(screen.getByTestId('sv-picker')).toBeInTheDocument()
    expect(screen.queryByTestId('palette-grid')).not.toBeInTheDocument()
  })

  it('switches back to palette mode from HSV mode', () => {
    renderPicker()
    fireEvent.click(screen.getByText('HSV'))
    expect(screen.queryByTestId('palette-grid')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Palette'))
    expect(screen.getByTestId('palette-grid')).toBeInTheDocument()
    expect(screen.queryByTestId('sv-picker')).not.toBeInTheDocument()
  })

  it('calls onColorChange with cell HSV values when a palette cell is clicked', () => {
    const { props } = renderPicker()
    const cell = getPaletteCells()[0]
    const [h, s, v] = getCellHsv(cell)
    fireEvent.click(cell)
    expect(props.onColorChange).toHaveBeenCalledTimes(1)
    expect(props.onColorChange).toHaveBeenCalledWith(h, s, v)
  })

  it('calls onColorChange with correct HSV for a chromatic cell', () => {
    const { props } = renderPicker()
    // Cell 10 is the first cell of row 1 (pastel row, col 0)
    const cell = getPaletteCells()[10]
    const [h, s, v] = getCellHsv(cell)
    fireEvent.click(cell)
    expect(props.onColorChange).toHaveBeenCalledWith(h, s, v)
  })

  it('shows nearest color indicator on the correct palette cell for exact match', () => {
    // h=0, s=0, v=255 is the first grayscale cell (white)
    renderPicker({ hue: 0, saturation: 0, value: 255 })
    const [, s, v] = getCellHsv(getSelectedCell())
    expect(s).toBe(0) // saturation 0 = grayscale
    expect(v).toBe(255) // value 255 = white
  })

  it('nearest indicator selects grayscale cell for low-saturation colors', () => {
    renderPicker({ hue: 128, saturation: 5, value: 200 })
    const [, s] = getCellHsv(getSelectedCell())
    expect(s).toBe(0) // should match a grayscale cell
  })

  it('last 10 cells (row 9) are grayscale (s=0)', () => {
    renderPicker()
    const cells = getPaletteCells()
    for (let i = 90; i < 100; i++) {
      const [, s] = getCellHsv(cells[i])
      expect(s).toBe(0)
    }
  })

})
