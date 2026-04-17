// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RGBConfigurator } from '../RGBConfigurator'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../HSVColorPicker', () => ({
  HSVColorPicker: () => <div data-testid="hsv-color-picker" />,
  hsvToRgb: () => [0, 0, 0] as [number, number, number],
  rgbToHsv: () => [0, 0, 0] as [number, number, number],
  rgbToHex: () => '#000000',
  hexToRgb: () => [0, 0, 0] as [number, number, number],
}))

function makeProps(overrides: Partial<Parameters<typeof RGBConfigurator>[0]> = {}): Parameters<typeof RGBConfigurator>[0] {
  const noop = vi.fn().mockResolvedValue(undefined)
  return {
    lightingType: 'qmk_rgblight',
    backlightBrightness: 0,
    backlightEffect: 0,
    rgblightBrightness: 128,
    rgblightEffect: 0,
    rgblightEffectSpeed: 128,
    rgblightHue: 0,
    rgblightSat: 255,
    vialRGBVersion: 0,
    vialRGBMode: 0,
    vialRGBSpeed: 0,
    vialRGBHue: 0,
    vialRGBSat: 0,
    vialRGBVal: 0,
    vialRGBMaxBrightness: 255,
    vialRGBSupported: [],
    onSetBacklightBrightness: noop,
    onSetBacklightEffect: noop,
    onSetRgblightBrightness: noop,
    onSetRgblightEffect: noop,
    onSetRgblightEffectSpeed: noop,
    onSetRgblightColor: noop,
    onSetVialRGBMode: noop,
    onSetVialRGBSpeed: noop,
    onSetVialRGBColor: noop,
    onSetVialRGBBrightness: noop,
    onSetVialRGBHSV: noop,
    onSave: noop,
    ...overrides,
  }
}

describe('RGBConfigurator (Save button dirty gating)', () => {
  it('disables Save on initial render when no values have changed', () => {
    render(<RGBConfigurator {...makeProps()} />)
    expect(screen.getByTestId('lighting-save')).toBeDisabled()
  })

  it('enables Save when a tracked prop differs from the initial snapshot', () => {
    const { rerender } = render(<RGBConfigurator {...makeProps({ rgblightEffectSpeed: 128 })} />)
    expect(screen.getByTestId('lighting-save')).toBeDisabled()

    rerender(<RGBConfigurator {...makeProps({ rgblightEffectSpeed: 200 })} />)
    expect(screen.getByTestId('lighting-save')).toBeEnabled()
  })

  it('re-disables Save after a successful save without requiring extra re-renders', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(<RGBConfigurator {...makeProps({ rgblightEffectSpeed: 128, onSave })} />)

    rerender(<RGBConfigurator {...makeProps({ rgblightEffectSpeed: 200, onSave })} />)
    expect(screen.getByTestId('lighting-save')).toBeEnabled()

    fireEvent.click(screen.getByTestId('lighting-save'))
    await waitFor(() => expect(onSave).toHaveBeenCalled())

    // Save's post-action snapshot update must trigger a re-render on its own
    // so the button reflects the new baseline without the parent having to
    // send fresh props.
    await waitFor(() => expect(screen.getByTestId('lighting-save')).toBeDisabled())
  })
})
