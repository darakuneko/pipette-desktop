// SPDX-License-Identifier: GPL-2.0-or-later
// What the mocks of the data-operation fixture generators
// (record-analytics-data-ops-fixtures.test.ts, tz-data-ops.test.ts) answer
// with, set by data-ops-harness.ts for each scenario. Kept free of other
// imports so the mock factories can load it before the modules they mock.

export const pinned = {
  userData: '',
  /** This device's machine hash. */
  ownHash: '',
  /** The ids `randomUUID` hands out, sessions and deleted ranges alike. */
  ids: [] as string[],
  /** The paths whose `unlink` fails with EACCES. */
  unlinkFailures: new Set<string>(),
  /** Every `log(level, message)` call, as `level: message`. */
  logs: [] as string[],
  /** Every sync unit announced, in order. */
  units: [] as string[],
}
