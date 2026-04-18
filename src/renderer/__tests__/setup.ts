// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// jsdom doesn't implement ResizeObserver, but several components (e.g.
// BasicKeyboardView, MacroTileGrid) rely on it. A minimal no-op shim lets
// jsdom-backed tests render them without the polyfill touching browser behavior.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}

afterEach(() => {
  cleanup()
})
