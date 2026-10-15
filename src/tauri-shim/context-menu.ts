// SPDX-License-Identifier: GPL-2.0-or-later
// Right-clicking opens the webview's menu on editable fields only, as in the
// Electron build, whose main process (src/main/index.ts) shows Cut, Copy,
// Paste and Select All for editable fields and no menu anywhere else.
// WebKitGTK's own menu outside them offers Back, Forward, Stop and Reload
// (and Inspect Element in debug builds); Reload would restart the app's
// page. Builds with the development tools keep the webview's menu
// everywhere, for Inspect Element.

/** Defined by the init script of the builds with the development tools
 *  (src-tauri/src/dev_commands/tools.rs). */
const DEV_TOOLS_MARK = '__PIPETTE_DEV_TOOLS__'

/** The input types whose value the user types or picks as text. */
const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'number',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
])

/** The values of `contenteditable` that make an element editable. */
const EDITABLE_CONTENT = new Set(['', 'true', 'plaintext-only'])

function isEditable(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(target.type) && !target.readOnly && !target.disabled
  }
  if (target instanceof HTMLTextAreaElement) return !target.readOnly && !target.disabled
  if (target instanceof HTMLSelectElement) return !target.disabled
  if (!(target instanceof Element)) return false
  // The nearest element that sets contenteditable decides.
  const host = target.closest('[contenteditable]')
  return host !== null && EDITABLE_CONTENT.has(host.getAttribute('contenteditable') ?? '')
}

/**
 * Cancels the menu of every right-click on `root` outside editable fields.
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

/** Suppresses the menu outside editable fields of `win`, unless the build
 *  has the development tools. */
export function installContextMenuPolicy(win: Window): void {
  if (DEV_TOOLS_MARK in win) return
  suppressContextMenuOutsideEditables(win.document)
}
