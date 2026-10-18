// SPDX-License-Identifier: GPL-2.0-or-later
//
// The checks of the rehearsal for a userData directory the app is started
// on by hand: on Windows and macOS, where a temporary OS user holds the
// copy (README.md). It only reads: `snapshot` records the directory before
// a launch, `compare` judges it after the app quit, with the rules of
// rules.ts.
//
//   tsx scripts/takeover-rehearsal/data-dir.ts snapshot --data <userData> --out <file>
//   tsx scripts/takeover-rehearsal/data-dir.ts compare  --data <userData> --before <file> [--operate]
//
// Exit codes: 0 passed, 1 findings to look at, 2 refused (a link in the
// copy, a snapshot of another directory, bad arguments).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkReadable, formatFinding, formatRead, judgeDataDir, type Finding, type ReadResult } from './rules'
import { RefusedError, diffTrees, snapshotOrRefuse, type Entry, type Snapshot } from './tree'

interface SavedSnapshot {
  data: string
  entries: Record<string, Entry>
  config: string | null
}

export interface Comparison {
  findings: Finding[]
  readable: ReadResult[]
  passed: boolean
}

const USAGE =
  'usage: data-dir.ts snapshot --data <userData> --out <file> | compare --data <userData> --before <file> [--operate]'

/** The state of `data` to compare with after a launch. */
export function saveSnapshot(data: string): SavedSnapshot {
  const config = join(data, 'config.json')
  return {
    data,
    entries: Object.fromEntries(snapshotOrRefuse(data)),
    config: existsSync(config) ? readFileSync(config, 'utf-8') : null,
  }
}

/** `data` now against `saved`: with `operate`, every new or changed file
 *  read by its rule and the removals listed; without, every change judged
 *  by the list of a launch without operations. */
export function compare(data: string, saved: SavedSnapshot, operate: boolean): Comparison {
  if (resolve(saved.data) !== resolve(data)) throw new RefusedError(`refused: the snapshot is of ${saved.data}, not ${data}`)
  const before: Snapshot = new Map(Object.entries(saved.entries))
  const after = snapshotOrRefuse(data)
  const diff = diffTrees(before, after)
  const findings = judgeDataDir(diff, { dataDir: data, before, after, prefix: '', configBefore: saved.config ?? undefined })
  if (!operate) return { findings, readable: [], passed: findings.every((finding) => finding.verdict !== 'violation') }
  const readable = checkReadable(data, [...diff.added, ...diff.changed].filter((path) => after.get(path)?.kind === 'file'))
  return {
    findings: findings.filter((finding) => finding.change === 'removed'),
    readable,
    passed: readable.every((result) => result.verdict !== 'unreadable'),
  }
}

function flag(args: string[], name: string): string {
  const at = args.indexOf(name)
  const value = at >= 0 ? args[at + 1] : undefined
  if (!value || !isAbsolute(value)) throw new RefusedError(`${USAGE}\n(${name} takes an absolute path)`)
  return value
}

function main(args: string[]): number {
  const [command, ...rest] = args
  if (command === 'snapshot') {
    const out = flag(rest, '--out')
    writeFileSync(out, `${JSON.stringify(saveSnapshot(flag(rest, '--data')))}\n`)
    console.log(`snapshot: ${out}`)
    return 0
  }
  if (command !== 'compare') throw new RefusedError(USAGE)
  const saved = JSON.parse(readFileSync(flag(rest, '--before'), 'utf-8')) as SavedSnapshot
  const result = compare(flag(rest, '--data'), saved, rest.includes('--operate'))
  for (const finding of result.findings) {
    console.log(formatFinding(finding))
  }
  for (const read of result.readable) console.log(formatRead(read))
  console.log(result.passed ? 'PASSED' : 'FINDINGS: look at the lines above before going further')
  return result.passed ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(err instanceof RefusedError ? 2 : 1)
  }
}
