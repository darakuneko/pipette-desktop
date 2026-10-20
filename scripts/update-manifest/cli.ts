// SPDX-License-Identifier: GPL-2.0-or-later
// The release workflows' entry to the update manifests (manifest.ts). The
// public key is always the one in src-tauri/tauri.conf.json.
//
//   npx tsx scripts/update-manifest/cli.ts build --version <v> --dir <dir> [--notes-file <f>]
//     reads each update file and its .sig from <dir>, verifies them and
//     writes <dir>/latest.json
//   npx tsx scripts/update-manifest/cli.ts check-promotion --tag <vX> --channel <c>
//       --release <release.json> --dir <dir> [--current <channel.json>]
//     <release.json>: `gh release view --json tagName,isDraft,isPrerelease,assets`;
//     <dir>: the release's latest.json, update files and .sig files as
//     downloaded anonymously; --current: the channel's manifest now, left
//     out when it has none. Exits 1 with the reasons when the release may
//     not become the channel's manifest.
//   npx tsx scripts/update-manifest/cli.ts pubkey
//     prints the public key's minisign line (for `minisign -V -P`)

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { verifySignature } from './minisign'
import {
  UPDATE_ASSETS,
  buildLatestJson,
  promotionProblems,
  readPubkey,
  type ReleaseInfo,
  type SignedFile,
} from './manifest'

function fail(message: string): never {
  console.error(`::error::${message}`)
  process.exit(1)
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === '') fail(`--${name} is required`)
  return value
}

function readSigned(dir: string): Map<string, SignedFile> {
  const files = new Map<string, SignedFile>()
  for (const { file } of UPDATE_ASSETS) {
    const path = join(dir, file)
    if (!existsSync(path) || !existsSync(`${path}.sig`)) fail(`${path} or ${path}.sig is missing`)
    files.set(file, { data: readFileSync(path), signature: readFileSync(`${path}.sig`, 'utf8') })
  }
  return files
}

function build(args: string[]): void {
  const { values } = parseArgs({ args, options: { version: { type: 'string' }, dir: { type: 'string' }, 'notes-file': { type: 'string' } } })
  const dir = required(values.dir, 'dir')
  const manifest = buildLatestJson({
    version: required(values.version, 'version'),
    pubDate: new Date().toISOString(),
    notes: values['notes-file'] === undefined ? undefined : readFileSync(values['notes-file'], 'utf8'),
    files: readSigned(dir),
    pubkey: readPubkey(),
  })
  writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`wrote ${join(dir, 'latest.json')} for ${manifest.version}`)
}

function checkPromotion(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      tag: { type: 'string' },
      channel: { type: 'string' },
      release: { type: 'string' },
      dir: { type: 'string' },
      current: { type: 'string' },
    },
  })
  const tag = required(values.tag, 'tag')
  const dir = required(values.dir, 'dir')
  const release = JSON.parse(readFileSync(required(values.release, 'release'), 'utf8')) as ReleaseInfo
  const manifest: unknown = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'))
  const signed = readSigned(dir)
  const signatures = Object.fromEntries([...signed].map(([file, { signature }]) => [file, signature]))
  const problems = promotionProblems({
    tag,
    channel: required(values.channel, 'channel'),
    release,
    manifest,
    signatures,
    current: values.current === undefined ? null : (JSON.parse(readFileSync(values.current, 'utf8')) as unknown),
  })
  const pubkey = readPubkey()
  const version = tag.replace(/^v/, '')
  for (const [file, { data, signature }] of signed) {
    try {
      verifySignature(data, signature.trim(), pubkey, version)
    } catch (err) {
      problems.push(`${file}: ${(err as Error).message}`)
    }
  }
  if (problems.length > 0) fail(`${tag} may not become the ${values.channel} manifest:\n- ${problems.join('\n- ')}`)
  console.log(`${tag} may become the ${values.channel} manifest`)
}

function pubkeyLine(): void {
  const file = Buffer.from(readPubkey(), 'base64').toString('utf8')
  const line = file.split('\n')[1]
  if (!line) fail('the public key has no key line')
  console.log(line.trim())
}

const [command, ...rest] = process.argv.slice(2)
switch (command) {
  case 'build':
    build(rest)
    break
  case 'check-promotion':
    checkPromotion(rest)
    break
  case 'pubkey':
    pubkeyLine()
    break
  default:
    fail('usage: cli.ts build | check-promotion | pubkey')
}
