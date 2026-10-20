// SPDX-License-Identifier: GPL-2.0-or-later
// TEST ONLY. A fixed minisign key pair for the fake update server and its
// tests, and signatures in the form `tauri signer sign` writes them. The
// private key is in this public repository on purpose: it signs nothing but
// test payloads, and only a build with the development tools accepts its
// public key (PIPETTE_DEV_UPDATER_PUBKEY). It is not, and must never
// become, the release key of src-tauri/tauri.conf.json.

import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { keyIdHex, signedBytes } from '../update-manifest/minisign'

/** The DER prefix of an Ed25519 private key in PKCS#8 form. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

const TEST_ONLY_SEED = Buffer.from('74657374206f6e6c793a207069706574746520666b2075706461746572206b31', 'hex')
const TEST_ONLY_KEY_ID = Buffer.from('7e57000000000001', 'hex')

const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, TEST_ONLY_SEED]), format: 'der', type: 'pkcs8' })
const publicKeyBytes = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)

/** The test key's public key in Tauri's form (base64 of the `.pub` file). */
export const TEST_ONLY_PUBKEY = Buffer.from(
  `untrusted comment: minisign public key: ${keyIdHex(TEST_ONLY_KEY_ID)}\n` +
    `${Buffer.concat([Buffer.from('Ed', 'latin1'), TEST_ONLY_KEY_ID, publicKeyBytes]).toString('base64')}\n`,
  'utf8',
).toString('base64')

export interface SignOptions {
  /** The version the signature binds (`--app-version`); none when absent. */
  version?: string
  file?: string
  timestamp?: number
}

/** `data` signed with the test key, as Tauri's `.sig` (base64 of the file). */
export function testOnlySign(data: Buffer, options: SignOptions = {}): string {
  const signature = sign(null, signedBytes(data, true), privateKey)
  const fields = [`timestamp:${options.timestamp ?? 1_760_000_000}`, `file:${options.file ?? 'update'}`]
  if (options.version !== undefined) fields.push(`version:${options.version}`)
  const trustedComment = fields.join('\t')
  const global = sign(null, Buffer.concat([signature, Buffer.from(trustedComment, 'utf8')]), privateKey)
  const file =
    'untrusted comment: signature from tauri secret key\n' +
    `${Buffer.concat([Buffer.from('ED', 'latin1'), TEST_ONLY_KEY_ID, signature]).toString('base64')}\n` +
    `trusted comment: ${trustedComment}\n` +
    `${global.toString('base64')}\n`
  return Buffer.from(file, 'utf8').toString('base64')
}
