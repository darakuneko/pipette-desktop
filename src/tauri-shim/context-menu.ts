// SPDX-License-Identifier: GPL-2.0-or-later
// Right-clicking opens the webview's menu on editable text only, as in the
// Electron build, whose main process (src/main/index.ts) shows Cut, Copy,
// Paste and Select All for editable fields and no menu anywhere else.
// WebKitGTK's own menu outside editable text offers Back, Forward, Stop and
// Reload (and Inspect Element in debug builds); Reload would restart the
// app's page.

/** The input types whose value is text the user types. */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number'])

function isEditable(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(target.type) && !target.readOnly && !target.disabled
  }
  if (target instanceof HTMLTextAreaElement) return !target.readOnly && !target.disabled
  return target instanceof HTMLElement && target.isContentEditable
}

/**
 * Cancels the menu of every right-click on `root` outside editable text.
 * Listens in the capture phase, so a page handler that stops the event
 * cannot bring the menu back.
 */
export function suppressContextMenuOutsideEditables(root: Document): void {
  root.addEventListener(
    'contextmenu',
    (event) => {
      if (!isEditable(event.target)) event.preventDefault()
    },
    { capture: true },
  )
}
