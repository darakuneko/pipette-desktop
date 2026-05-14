// SPDX-License-Identifier: GPL-2.0-or-later

// Icon sizes (px) for lucide-react `size` prop.
export const ICON_XS = 12 // Tiny indicators (chevrons in selects)
export const ICON_SM = 14 // Inline icons in buttons, list rows
export const ICON_MD = 16 // Standard toolbar / modal icons
export const ICON_LG = 20 // Close buttons, prominent actions
export const ICON_XL = 18 // Checkbox/radio-style status icons

// Icon button (rounded icon-only button)
export const ICON_BTN_BASE = 'rounded p-1 text-content-muted hover:text-content transition-colors'

// Standard modal / form buttons (text-sm, py-1.5)
export const BTN_PRIMARY = 'rounded bg-accent px-3 py-1.5 text-sm font-medium text-content-inverse hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed'
export const BTN_SECONDARY = 'rounded border border-edge px-3 py-1.5 text-sm text-content-secondary hover:bg-surface-dim disabled:opacity-50 disabled:cursor-not-allowed'
export const BTN_DANGER_OUTLINE = 'rounded border border-danger px-3 py-1.5 text-sm text-danger hover:bg-danger/10 disabled:opacity-50 disabled:cursor-not-allowed'

// Toolbar toggle buttons (rounded-md, p-2)
export const TOOLBAR_BTN_BASE = 'rounded-md border p-2 transition-colors'
export const TOOLBAR_BTN_ACTIVE = `${TOOLBAR_BTN_BASE} border-accent bg-accent/10 text-accent`
export const TOOLBAR_BTN_INACTIVE = `${TOOLBAR_BTN_BASE} border-edge text-content-secondary hover:text-content`
