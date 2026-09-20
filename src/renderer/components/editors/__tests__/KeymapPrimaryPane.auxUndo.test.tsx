// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// `auxUndoHandlers` threading and the selection gate: the editable
// KeyboardPane branch receives handlers wrapped so middle-click only fires
// for the currently selected key/encoder, the pack-tab simulation preview
// branch never receives anything (it takes no selection/edit props at
// all). The caller's View Matrix gating is covered by
// KeymapEditor.viewMatrix.test.tsx.

import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { KeymapPrimaryPane } from '../KeymapPrimaryPane'
import type { UseViewMatrixModeReturn } from '../useViewMatrixMode'

let capturedOnKeyAuxClick: ((pos: { row: number; col: number }) => void) | undefined
let capturedOnEncoderAuxClick: ((pos: { idx: number; dir: number }) => void) | undefined

vi.mock('../KeyboardPane', () => ({
  KeyboardPane: (props: {
    onKeyAuxClick?: (pos: { row: number; col: number }) => void
    onEncoderAuxClick?: (pos: { idx: number; dir: number }) => void
  }) => {
    capturedOnKeyAuxClick = props.onKeyAuxClick
    capturedOnEncoderAuxClick = props.onEncoderAuxClick
    return <div data-testid="keyboard-pane" />
  },
}))

vi.mock('../KeymapPackTabs', () => ({
  KeymapPackTabs: () => <div data-testid="pack-tabs" />,
  KeymapPackApplyButton: () => null,
}))

const viewMatrixMode: UseViewMatrixModeReturn = {
  active: false,
  enter: vi.fn(),
  exit: vi.fn(),
  toggle: vi.fn(),
  selectedKeys: new Set(),
  selectKey: vi.fn(),
  toggleKeySelection: vi.fn(),
  extendSelection: vi.fn(),
  clearSelection: vi.fn(),
}

function baseProps() {
  return {
    showPackTabs: false,
    packTab: 'pack' as const,
    keys: [],
    layerKeycodes: new Map<string, string>(),
    layerEncoderKeycodes: new Map<string, [string, string]>(),
    remappedKeys: new Set<string>(),
    layerEncoderRemapped: new Set<string>(),
    matrixMode: false,
    pressedKeys: new Set<string>(),
    everPressedKeys: new Set<string>(),
    layoutOptions: new Map<number, number>(),
    scale: 1,
    currentLayerLabel: 'Layer 0',
    primaryKeycodes: new Map<string, string>(),
    primaryEncoderKeycodes: new Map<string, [string, string]>(),
    selectedKey: null,
    selectedEncoder: null,
    selectedMaskPart: false,
    selectedKeycode: null,
    primaryRemappedKeys: new Set<string>(),
    primaryRemappedEncoders: new Set<string>(),
    viewMatrixMode,
    multiSelectedKeys: new Set<string>(),
    handleViewMatrixKeyClick: vi.fn(),
    handleKeyClick: vi.fn(),
    handleKeyDoubleClick: vi.fn(),
    handleEncoderClick: vi.fn(),
    handleEncoderDoubleClick: vi.fn(),
    handleDeselect: vi.fn(),
    handlePackTabChange: vi.fn(),
  }
}

describe('KeymapPrimaryPane — auxUndoHandlers threading', () => {
  it('threads a wrapped handler to the editable KeyboardPane branch, which calls through for the selected key', () => {
    const onKeyAuxClick = vi.fn()
    const onEncoderAuxClick = vi.fn()
    render(
      <KeymapPrimaryPane
        {...baseProps()}
        selectedKey={{ row: 1, col: 2 }}
        auxUndoHandlers={{ onKeyAuxClick, onEncoderAuxClick }}
      />,
    )
    expect(capturedOnKeyAuxClick).toBeInstanceOf(Function)
    // Wrapped for the selection gate below, so this is no longer the same
    // function reference as the bundled `onKeyAuxClick` — assert behavior
    // (calls through when the position matches the selection) instead.
    capturedOnKeyAuxClick?.({ row: 1, col: 2 })
    expect(onKeyAuxClick).toHaveBeenCalledWith({ row: 1, col: 2 })
  })

  it('leaves both undefined when auxUndoHandlers is omitted (e.g. View Matrix mode at the caller)', () => {
    render(<KeymapPrimaryPane {...baseProps()} />)
    expect(capturedOnKeyAuxClick).toBeUndefined()
    expect(capturedOnEncoderAuxClick).toBeUndefined()
  })

  it('never reaches the pack simulation preview branch (packTab === "pack" with showPackTabs)', () => {
    const onKeyAuxClick = vi.fn()
    const onEncoderAuxClick = vi.fn()
    render(
      <KeymapPrimaryPane
        {...baseProps()}
        showPackTabs
        packTab="pack"
        auxUndoHandlers={{ onKeyAuxClick, onEncoderAuxClick }}
      />,
    )
    // The pack-tab preview branch passes no selection/edit props at all —
    // it must not receive the aux handlers either.
    expect(capturedOnKeyAuxClick).toBeUndefined()
    expect(capturedOnEncoderAuxClick).toBeUndefined()
  })
})

describe('KeymapPrimaryPane — middle-click undo only fires for the current selection', () => {
  it('calls onKeyAuxClick when the middle-clicked position matches selectedKey', () => {
    const onKeyAuxClick = vi.fn()
    const onEncoderAuxClick = vi.fn()
    render(
      <KeymapPrimaryPane
        {...baseProps()}
        selectedKey={{ row: 1, col: 2 }}
        auxUndoHandlers={{ onKeyAuxClick, onEncoderAuxClick }}
      />,
    )
    capturedOnKeyAuxClick?.({ row: 1, col: 2 })
    expect(onKeyAuxClick).toHaveBeenCalledWith({ row: 1, col: 2 })
  })

  it('does not call onKeyAuxClick when the middle-clicked key is a different, unselected key', () => {
    const onKeyAuxClick = vi.fn()
    const onEncoderAuxClick = vi.fn()
    render(
      <KeymapPrimaryPane
        {...baseProps()}
        selectedKey={{ row: 1, col: 2 }}
        auxUndoHandlers={{ onKeyAuxClick, onEncoderAuxClick }}
      />,
    )
    capturedOnKeyAuxClick?.({ row: 3, col: 4 })
    expect(onKeyAuxClick).not.toHaveBeenCalled()
  })

  it('does not call onKeyAuxClick when nothing is selected', () => {
    const onKeyAuxClick = vi.fn()
    const onEncoderAuxClick = vi.fn()
    render(
      <KeymapPrimaryPane
        {...baseProps()}
        auxUndoHandlers={{ onKeyAuxClick, onEncoderAuxClick }}
      />,
    )
    capturedOnKeyAuxClick?.({ row: 0, col: 0 })
    expect(onKeyAuxClick).not.toHaveBeenCalled()
  })

  it('calls onEncoderAuxClick when the middle-clicked idx/dir matches selectedEncoder', () => {
    const onKeyAuxClick = vi.fn()
    const onEncoderAuxClick = vi.fn()
    render(
      <KeymapPrimaryPane
        {...baseProps()}
        selectedEncoder={{ idx: 2, dir: 1 }}
        auxUndoHandlers={{ onKeyAuxClick, onEncoderAuxClick }}
      />,
    )
    capturedOnEncoderAuxClick?.({ idx: 2, dir: 1 })
    expect(onEncoderAuxClick).toHaveBeenCalledWith({ idx: 2, dir: 1 })
  })

  it('does not call onEncoderAuxClick when the same idx but a different dir is middle-clicked', () => {
    const onKeyAuxClick = vi.fn()
    const onEncoderAuxClick = vi.fn()
    render(
      <KeymapPrimaryPane
        {...baseProps()}
        selectedEncoder={{ idx: 2, dir: 1 }}
        auxUndoHandlers={{ onKeyAuxClick, onEncoderAuxClick }}
      />,
    )
    capturedOnEncoderAuxClick?.({ idx: 2, dir: 0 })
    expect(onEncoderAuxClick).not.toHaveBeenCalled()
  })

  it('does not call onEncoderAuxClick when a key, not an encoder, is currently selected', () => {
    const onKeyAuxClick = vi.fn()
    const onEncoderAuxClick = vi.fn()
    render(
      <KeymapPrimaryPane
        {...baseProps()}
        selectedKey={{ row: 0, col: 0 }}
        auxUndoHandlers={{ onKeyAuxClick, onEncoderAuxClick }}
      />,
    )
    capturedOnEncoderAuxClick?.({ idx: 0, dir: 0 })
    expect(onEncoderAuxClick).not.toHaveBeenCalled()
  })
})
