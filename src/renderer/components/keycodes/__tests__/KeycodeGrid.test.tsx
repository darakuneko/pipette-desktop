// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// Coverage for `KeycodeGrid`'s remap tint: the color decision is driven
// purely by `remapLabel`'s own label-diff (`getRemapDisplayLabel`'s
// `displayLabel != null`) — there is no separate gated `isRemapped`
// channel. Applied mode (which used to need one) no longer exists —
// Rewrite is a destructive one-shot that resets the select back to
// QWERTY, so Display Only is the only remap-rendering mode, and the
// picker derives its tint locally from the same label-diff. Covers both
// the plain (`KeycodeButton`) and split (`SplitKey`) render paths.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { KeycodeGrid } from '../KeycodeGrid'
import { findKeycode, type Keycode } from '../../../../shared/keycodes/keycodes'

const KC_A = findKeycode('KC_A') as Keycode
// KC_1 has a shifted counterpart (KC_EXLM) — exercises the SplitKey path.
const KC_1 = findKeycode('KC_1') as Keycode

describe('KeycodeGrid — remap tint (label-diff)', () => {
  it('tints a plain keycode button when remapLabel returns a different label', () => {
    render(
      <KeycodeGrid
        keycodes={[KC_A]}
        splitKeyMode="flat"
        remapLabel={(id) => (id === 'KC_A' ? 'Custom A' : id)}
      />,
    )
    const btn = screen.getByRole('button')
    expect(btn.className).toContain('text-key-label-remap')
    expect(screen.getByText('Custom A')).toBeInTheDocument()
  })

  it('does not tint a plain keycode button when remapLabel returns the same qmkId (identity)', () => {
    render(
      <KeycodeGrid
        keycodes={[KC_A]}
        splitKeyMode="flat"
        remapLabel={(id) => id}
      />,
    )
    expect(screen.getByRole('button').className).not.toContain('text-key-label-remap')
  })

  it('does not tint when remapLabel is absent', () => {
    render(<KeycodeGrid keycodes={[KC_A]} splitKeyMode="flat" />)
    expect(screen.getByRole('button').className).not.toContain('text-key-label-remap')
  })

  it('tints both halves of a split keycode pair when the pack remaps the base keycode', () => {
    // getSplitRemapProps keys the whole pair off the BASE qmkId alone (see
    // its own doc comment) — a multi-line remap value ("shifted\nbase")
    // supplies both halves' display labels from that single lookup.
    render(
      <KeycodeGrid
        keycodes={[KC_1]}
        splitKeyMode="split"
        remapLabel={(id) => (id === 'KC_1' ? 'Custom!\nCustom1' : id)}
      />,
    )
    expect(screen.getByText('Custom1').closest('button')?.className).toContain('text-key-label-remap')
    expect(screen.getByText('Custom!').closest('button')?.className).toContain('text-key-label-remap')
  })

  it('leaves a split keycode pair untinted when remapLabel is identity for the base keycode', () => {
    render(
      <KeycodeGrid
        keycodes={[KC_1]}
        splitKeyMode="split"
        remapLabel={(id) => id}
      />,
    )
    expect(screen.getByText('1').closest('button')?.className).not.toContain('text-key-label-remap')
    expect(screen.getByText('!').closest('button')?.className).not.toContain('text-key-label-remap')
  })
})
