// SPDX-License-Identifier: GPL-2.0-or-later

/** Formats `value` as a locale-aware display string for interpolation into
 *  an i18next `count` option. i18next's types reserve `count` for the
 *  numeric plural option, so a preformatted string needs a cast to satisfy
 *  the type — safe here because the target keys have no plural variants. */
export function localeCount(value: number): number {
  return value.toLocaleString() as unknown as number
}
