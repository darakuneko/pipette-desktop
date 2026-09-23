// SPDX-License-Identifier: GPL-2.0-or-later

// Shared helpers for the flash overlay DOM tests (KeyWidget, EncoderWidget,
// KeyFlashOverlay).

export function attrs(el: Element): Record<string, string> {
  return Object.fromEntries(Array.from(el.attributes, (a) => [a.name, a.value]))
}

// Serialized `style` of each layer with a zero `flashElapsedMs` (jsdom
// writes `-0ms` as `0ms`).
export const FILL_STYLE = 'pointer-events: none; animation-delay: 0ms;'
export const BORDER_STYLE = 'pointer-events: none;'
