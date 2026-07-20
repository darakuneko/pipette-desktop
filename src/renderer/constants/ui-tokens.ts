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
export const BTN_DANGER = 'rounded bg-danger px-3 py-1.5 text-sm font-medium text-content-inverse hover:bg-danger/90 disabled:opacity-50 disabled:cursor-not-allowed'
export const BTN_PRIMARY_XS = 'rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-content-inverse hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed'
export const BTN_DANGER_XS = 'rounded-lg bg-danger px-3 py-1.5 text-xs font-semibold text-content-inverse hover:bg-danger/90 disabled:opacity-50 disabled:cursor-not-allowed'

// Toolbar toggle buttons (rounded-md, p-2)
export const TOOLBAR_BTN_BASE = 'rounded-md border p-2 transition-colors'
export const TOOLBAR_BTN_ACTIVE = `${TOOLBAR_BTN_BASE} border-accent bg-accent/10 text-accent`
export const TOOLBAR_BTN_INACTIVE = `${TOOLBAR_BTN_BASE} border-edge text-content-secondary hover:text-content`

// Compact text toggle buttons (px-2 py-1) — StatusBar / TypingTestPane tabs
export const BTN_TOGGLE_ACTIVE = 'rounded border border-accent bg-accent/10 px-2 py-1 text-sm text-accent transition-colors'
export const BTN_TOGGLE_INACTIVE = 'rounded border border-edge px-2 py-1 text-sm text-content-secondary transition-colors hover:text-content'

// Borderless segments inside a bordered container (px-1.5 py-0.5 text-xs) —
// segmented controls that must stay compact, e.g. the Analyze filter-row
// App / TypingTest dimension toggle. The container draws the single border.
export const SEGMENT_TOGGLE_ACTIVE = 'rounded px-1.5 py-0.5 text-xs text-accent bg-accent/10 transition-colors'
export const SEGMENT_TOGGLE_INACTIVE = 'rounded px-1.5 py-0.5 text-xs text-content-secondary transition-colors hover:text-content'

// Accent-outline button — non-destructive secondary CTA on accent color
export const BTN_ACCENT_OUTLINE = 'rounded border border-accent bg-accent/10 px-3 py-1.5 text-sm text-accent hover:bg-accent/20 disabled:opacity-50 disabled:cursor-not-allowed'

// Footer-sized primary button — BTN_PRIMARY's accent-fill color at the
// footer/status-bar action buttons' size (rounded, px-2.5 py-1, text-xs,
// leading-none — see StatusBar.tsx's TYPING_TEST_BASE and
// QuickSettingsSelects.tsx's BUTTON_CLASS). For primary actions that sit
// in a footer row and must not dominate it the way BTN_PRIMARY's text-sm
// py-1.5 would.
export const BTN_PRIMARY_FOOTER = 'rounded bg-accent px-2.5 py-1 text-xs leading-none font-medium text-content-inverse hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed'
