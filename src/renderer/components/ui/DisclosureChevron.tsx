// SPDX-License-Identifier: GPL-2.0-or-later
// Triangle marker for a collapsible tree row: points right while
// closed and rotates 90° when open. Decorative; the row's button
// carries `aria-expanded`.

export function DisclosureChevron({ open }: { open: boolean }) {
  return (
    <span
      className={`inline-block text-3xs text-content-muted transition-transform ${open ? 'rotate-90' : ''}`}
      aria-hidden="true"
    >
      &#9654;
    </span>
  )
}
