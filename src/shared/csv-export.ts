// SPDX-License-Identifier: GPL-2.0-or-later
// Generic CSV builder used by anything that wants to round-trip
// tabular data through `window.vialAPI.exportCsv`. Intentionally
// minimal: header row, escaped fields, joined with `\n`. Callers
// keep their own header constants and row mappers so the generic
// helpers don't need a schema parameter.

export function escapeCsvField(value: unknown): string {
  let str = value == null ? '' : String(value)
  // Strip leading whitespace before the formula-injection check so an
  // attacker can't pad with spaces / tabs to slip past it.
  str = str.replace(/^[\t\r\n ]+/, '')
  if (str.length > 0 && '=+-@'.includes(str[0])) {
    str = `'${str}`
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

export function buildCsv(
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): string {
  const headerLine = headers.join(',')
  const dataLines = rows.map((row) => row.map(escapeCsvField).join(','))
  return [headerLine, ...dataLines].join('\n')
}
