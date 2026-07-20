// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// Plan-qwerty-select-no-rewrite v7 — シミュレーションタブ方式: `readOnly` is the
// single choke point `KeymapEditor` relies on to make the simulation tab
// completely view-only. This exercises it against the REAL `KeyboardWidget`
// (not mocked, unlike most KeymapEditor-level tests) so the DOM click path
// itself — not just prop threading — is proven blocked.

import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { KeyboardPane } from '../KeyboardPane'
import type { KleKey } from '../../../../shared/kle/types'

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  keycodeLabel: (kc: string) => kc,
  isMask: () => false,
  findOuterKeycode: () => undefined,
  findInnerKeycode: () => undefined,
}))

// KeyboardPane's only i18n usage is the `preview` prop's "Preview - "
// prefix (`editor.keymap.layerPreview`) — mocked the same way
// KeymapEditor.packTabs.test.tsx mocks it, since this file otherwise
// renders the real (unmocked) KeyboardWidget/KeyWidget tree and has no
// I18nextProvider in scope.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      key === 'editor.keymap.layerPreview' ? `Preview - ${String(opts?.label ?? '')}` : key,
  }),
}))

const KEY: KleKey = {
  x: 0, y: 0, width: 1, height: 1, row: 0, col: 0,
  encoderIdx: -1, encoderDir: -1, layoutIndex: -1, layoutOption: -1,
  decal: false, labels: [], x2: 0, y2: 0, width2: 1, height2: 1,
  rotation: 0, rotationX: 0, rotationY: 0, color: '',
  textColor: [], textSize: [], nub: false, stepped: false, ghost: false,
}

function baseProps() {
  return {
    paneId: 'primary' as const,
    isActive: true,
    keys: [KEY],
    keycodes: new Map([['0,0', 'KC_A']]),
    encoderKeycodes: new Map<string, [string, string]>(),
    selectedKey: null,
    selectedEncoder: null,
    selectedMaskPart: false,
    selectedKeycode: null,
    remappedKeys: new Set<string>(),
    layoutOptions: new Map<number, number>(),
    scale: 1,
    layerLabelTestId: 'layer-label',
  }
}

describe('KeyboardPane — readOnly (Plan-qwerty-select-no-rewrite v7)', () => {
  it('readOnly blocks a real click on the rendered key from reaching onKeyClick', () => {
    const onKeyClick = vi.fn()
    const { container } = render(
      <KeyboardPane {...baseProps()} readOnly onKeyClick={onKeyClick} />,
    )
    const keyGroup = container.querySelector('[data-key-pos="0,0"]')
    expect(keyGroup).not.toBeNull()
    fireEvent.click(keyGroup!)
    expect(onKeyClick).not.toHaveBeenCalled()
  })

  it('readOnly blocks a real double-click from reaching onKeyDoubleClick', () => {
    const onKeyDoubleClick = vi.fn()
    const { container } = render(
      <KeyboardPane {...baseProps()} readOnly onKeyDoubleClick={onKeyDoubleClick} />,
    )
    const keyGroup = container.querySelector('[data-key-pos="0,0"]')
    fireEvent.doubleClick(keyGroup!)
    expect(onKeyDoubleClick).not.toHaveBeenCalled()
  })

  it('without readOnly, the same click reaches onKeyClick normally', () => {
    const onKeyClick = vi.fn()
    const { container } = render(
      <KeyboardPane {...baseProps()} onKeyClick={onKeyClick} />,
    )
    const keyGroup = container.querySelector('[data-key-pos="0,0"]')
    fireEvent.click(keyGroup!)
    expect(onKeyClick).toHaveBeenCalledTimes(1)
  })

  it('readOnly still lets the deselect-on-background-click behavior stay off (onDeselect not fired) rather than firing spuriously', () => {
    const onDeselect = vi.fn()
    const { container } = render(
      <KeyboardPane {...baseProps()} readOnly onDeselect={onDeselect} />,
    )
    fireEvent.click(container.querySelector('[data-testid="primary-pane"]')!)
    expect(onDeselect).not.toHaveBeenCalled()
  })

  it('renders footerExtra content next to the layer label', () => {
    const { getByTestId } = render(
      <KeyboardPane {...baseProps()} layerLabel="Layer 0" footerExtra={<button data-testid="apply-btn">Apply</button>} />,
    )
    expect(getByTestId('apply-btn')).toBeTruthy()
    expect(getByTestId('layer-label')).toHaveTextContent('Layer 0')
  })

  it('places footerExtra in the right-hand cell, not centered between the layer label and the selected-keycode info', () => {
    const { getByTestId } = render(
      <KeyboardPane {...baseProps()} layerLabel="Layer 0" footerExtra={<button data-testid="apply-btn">Apply</button>} />,
    )
    const footerRow = getByTestId('layer-label').parentElement!.parentElement!
    // Two cells now, not three — the middle "centered" column is gone
    // (see KeyboardPane.tsx's comment: footerExtra and the
    // selected-keycode info never render at once, so they share the
    // right-hand cell instead of each owning a separate grid column).
    expect(footerRow.children).toHaveLength(2)
    const rightCell = footerRow.children[1]
    expect(rightCell.contains(getByTestId('apply-btn'))).toBe(true)
    expect(rightCell.contains(getByTestId('layer-label'))).toBe(false)
  })

  it('prefixes the layer label with "Preview - " when `preview` is set — the simulation tab\'s pane', () => {
    const { getByTestId } = render(
      <KeyboardPane {...baseProps()} layerLabel="Layer 0" preview readOnly footerExtra={<button data-testid="apply-btn">Apply</button>} />,
    )
    expect(getByTestId('layer-label')).toHaveTextContent('Preview - Layer 0')
  })

  it('leaves the layer label plain when `preview` is omitted, even though the pane is readOnly (e.g. View Matrix mode)', () => {
    const { getByTestId } = render(
      <KeyboardPane {...baseProps()} layerLabel="Layer 0" readOnly />,
    )
    expect(getByTestId('layer-label')).toHaveTextContent('Layer 0')
    expect(getByTestId('layer-label')).not.toHaveTextContent('Preview')
  })
})
