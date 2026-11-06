// SPDX-License-Identifier: GPL-2.0-or-later

/** True on the Linux (WebKitGTK) WebView. There, an IM-context commit
 *  that never shows up as a keydown — a dead-key letter (´ + o → ó), or
 *  an ibus / fcitx commit outside a composition — reaches the page only
 *  as an `insertText` input event on the hidden IME textarea. Windows
 *  and macOS deliver the same text through keydown / compositionend, so
 *  the insertText path is enabled on Linux only. Tauri runs on desktop
 *  only, so "linux" here never means Android. */
export function isLinuxWebView(): boolean {
  return typeof navigator !== 'undefined' && /linux/i.test(navigator.userAgent)
}

/** Evaluated once: the user agent never changes while the app runs. */
export const IS_LINUX_WEBVIEW = isLinuxWebView()

/** The text committed by a non-composition `input` event, or null when the
 *  event is not a plain text insertion. Composition, paste, drop and
 *  replacement inputs are excluded: composition text arrives through
 *  compositionend, and the others are not typing. NFC-normalized because a
 *  Compose sequence may commit a base letter plus a combining mark. */
export function toInsertedText(inputType: string, data: string | null): string | null {
  if (inputType !== 'insertText' || !data) return null
  return data.normalize('NFC')
}
