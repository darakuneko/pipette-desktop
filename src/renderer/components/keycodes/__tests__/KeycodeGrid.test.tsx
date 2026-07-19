// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// Coverage for `isRemapped` threading (Plan-qwerty-select-no-rewrite):
// `KeycodeGrid` must color entries by the gated `isRemapped` predicate,
// not by `remapLabel`'s own label-diff — the two diverge once a Key Label
// Rewrite is applied (raw label, but the Rewrite TARGET keycode still
// needs the blue tint). Covers both the plain (`KeycodeButton`) and split
// (`SplitKey`) render paths.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { KeycodeGrid } from '../KeycodeGrid'
import { findKeycode, type Keycode } from '../../../../shared/keycodes/keycodes'

const KC_A = findKeycode('KC_A') as Keycode
// KC_1 has a shifted counterpart (KC_EXLM) — exercises the SplitKey path.
const KC_1 = findKeycode('KC_1') as Keycode

describe('KeycodeGrid — isRemapped threading', () => {
  it('tints a plain keycode button when isRemapped(qmkId) is true, independent of remapLabel', () => {
    // Identity remapLabel (applied mode: legend stays raw) + a target-set
    // isRemapped that flags KC_A as a Rewrite target.
    render(
      <KeycodeGrid
        keycodes={[KC_A]}
        splitKeyMode="flat"
        remapLabel={(id) => id}
        isRemapped={(id) => id === 'KC_A'}
      />,
    )
    const btn = screen.getByRole('button')
    expect(btn.className).toContain('text-key-label-remap')
    // Label stays raw — remapLabel is identity.
    expect(screen.getByText('A')).toBeInTheDocument()
  })

  it('does not tint a plain keycode button when isRemapped(qmkId) is false', () => {
    render(
      <KeycodeGrid
        keycodes={[KC_A]}
        splitKeyMode="flat"
        remapLabel={(id) => id}
        isRemapped={() => false}
      />,
    )
    expect(screen.getByRole('button').className).not.toContain('text-key-label-remap')
  })

  it('does not tint when isRemapped is absent, even with a remapLabel present', () => {
    render(
      <KeycodeGrid
        keycodes={[KC_A]}
        splitKeyMode="flat"
        remapLabel={(id) => id}
      />,
    )
    expect(screen.getByRole('button').className).not.toContain('text-key-label-remap')
  })

  it('forwards a target-set isRemapped to SplitKey for a split keycode pair', () => {
    render(
      <KeycodeGrid
        keycodes={[KC_1]}
        splitKeyMode="split"
        remapLabel={(id) => id}
        isRemapped={(id) => id === 'KC_1'}
      />,
    )
    // Both halves of the split tile share the base keycode's remap
    // decision (see SplitKey's `remapped` doc comment). The color class
    // lives on each half's own <button>, not the label <span>.
    expect(screen.getByText('1').closest('button')?.className).toContain('text-key-label-remap')
    expect(screen.getByText('!').closest('button')?.className).toContain('text-key-label-remap')
  })

  it('leaves a split keycode pair untinted when isRemapped is false for its base qmkId', () => {
    render(
      <KeycodeGrid
        keycodes={[KC_1]}
        splitKeyMode="split"
        remapLabel={(id) => id}
        isRemapped={() => false}
      />,
    )
    expect(screen.getByText('1').closest('button')?.className).not.toContain('text-key-label-remap')
    expect(screen.getByText('!').closest('button')?.className).not.toContain('text-key-label-remap')
  })
})
