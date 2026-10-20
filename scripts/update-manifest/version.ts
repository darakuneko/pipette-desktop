// SPDX-License-Identifier: GPL-2.0-or-later
// Semantic versions as the app's updater compares them (the semver crate):
// precedence by major, minor, patch, then the pre-release identifiers
// (numeric ones compared as numbers and below alphanumeric ones, a version
// without a pre-release part above one with); build metadata ignored.

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export interface Version {
  major: number
  minor: number
  patch: number
  pre: string[]
}

/** `text` (a leading `v` allowed) parsed; throws when it is not semver. */
export function parseVersion(text: string): Version {
  const match = SEMVER.exec(text.replace(/^v/, ''))
  if (!match) throw new Error(`${JSON.stringify(text)} is not a semantic version`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** Whether `text` has a pre-release part. */
export function isPreRelease(text: string): boolean {
  return parseVersion(text).pre.length > 0
}

function compareIdentifiers(a: string, b: string): number {
  const numeric = (s: string): boolean => /^\d+$/.test(s)
  if (numeric(a) && numeric(b)) return Math.sign(Number(a) - Number(b))
  if (numeric(a)) return -1
  if (numeric(b)) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** Negative, zero or positive as `a` is below, equal to or above `b`. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (x[key] !== y[key]) return Math.sign(x[key] - y[key])
  }
  if (x.pre.length === 0 || y.pre.length === 0) return Math.sign(y.pre.length - x.pre.length)
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const order = compareIdentifiers(x.pre[i], y.pre[i])
    if (order !== 0) return order
  }
  return Math.sign(x.pre.length - y.pre.length)
}
