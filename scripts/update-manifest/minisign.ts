// SPDX-License-Identifier: GPL-2.0-or-later
// minisign as the Tauri updater uses it: the public key and each signature
// are the text of a minisign file, base64-encoded once more (the `pubkey` of
// src-tauri/tauri.conf.json, the `.sig` files `tauri signer sign` writes and
// the `signature` of the update manifest). The app verifies with the
// minisign-verify crate; this is the same check in Node, for the release
// scripts and the fake update server of the tests.
//
// A signature file is four lines: an untrusted comment, base64 of the
// algorithm (`ED`: Ed25519 over the BLAKE2b-512 hash of the file; `Ed`: over
// the file itself), the 8-byte key id and the 64-byte signature, then
// `trusted comment: <text>`, then base64 of the global signature: Ed25519
// over the signature and the trusted comment's text. Tauri's trusted
// comment is `timestamp:<s>\tfile:<name>\tversion:<v>`, the version being
// the one `--app-version` binds.

import { createHash, createPublicKey, verify as verifyEd25519, type KeyObject } from 'node:crypto'

/** The DER prefix of an Ed25519 public key in SubjectPublicKeyInfo form. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export interface PublicKey {
  /** The key id as minisign prints it: the 8 bytes little-endian, in hex. */
  keyId: string
  keyIdBytes: Buffer
  key: KeyObject
}

export interface Signature {
  prehashed: boolean
  keyIdBytes: Buffer
  signature: Buffer
  trustedComment: string
  globalSignature: Buffer
}

/** `text` decoded from base64, failing on anything that is not base64. */
function fromBase64(text: string, what: string): Buffer {
  const trimmed = text.trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) throw new Error(`${what} is not base64`)
  return Buffer.from(trimmed, 'base64')
}

/** The id of the key bytes `id`, as minisign prints it. */
export function keyIdHex(id: Buffer): string {
  return Buffer.from(id).reverse().toString('hex').toUpperCase()
}

/** The lines of a minisign file, without the line ends. */
function lines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n').filter((line, i, all) => line !== '' || i < all.length - 1)
}

/** The Tauri form of a public key (base64 of the `.pub` file) decoded. */
export function decodePublicKey(tauriPubkey: string): PublicKey {
  const file = fromBase64(tauriPubkey, 'the public key').toString('utf8')
  const [comment, body] = lines(file)
  if (!comment?.startsWith('untrusted comment:') || body === undefined) throw new Error('the public key is not a minisign public key file')
  const bytes = fromBase64(body, 'the public key line')
  if (bytes.length !== 42 || bytes.subarray(0, 2).toString('latin1') !== 'Ed') throw new Error('the public key is not an Ed25519 minisign key')
  const keyIdBytes = bytes.subarray(2, 10)
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, bytes.subarray(10)]), format: 'der', type: 'spki' })
  return { keyId: keyIdHex(keyIdBytes), keyIdBytes, key }
}

/** The Tauri form of a signature (base64 of the `.sig` file) decoded. */
export function decodeSignature(tauriSignature: string): Signature {
  const file = fromBase64(tauriSignature, 'the signature').toString('utf8')
  const [comment, body, trusted, global] = lines(file)
  if (!comment?.startsWith('untrusted comment:') || body === undefined || global === undefined || !trusted?.startsWith('trusted comment: ')) {
    throw new Error('the signature is not a minisign signature file')
  }
  const bytes = fromBase64(body, 'the signature line')
  const algorithm = bytes.subarray(0, 2).toString('latin1')
  if (bytes.length !== 74 || (algorithm !== 'ED' && algorithm !== 'Ed')) throw new Error('the signature is not an Ed25519 minisign signature')
  const globalSignature = fromBase64(global, 'the global signature')
  if (globalSignature.length !== 64) throw new Error('the global signature has the wrong length')
  return {
    prehashed: algorithm === 'ED',
    keyIdBytes: bytes.subarray(2, 10),
    signature: bytes.subarray(10),
    trustedComment: trusted.slice('trusted comment: '.length),
    globalSignature,
  }
}

/** The version a trusted comment binds (`version:<v>`), if any. */
export function signedVersion(trustedComment: string): string | undefined {
  for (const field of trustedComment.split('\t')) {
    if (field.startsWith('version:')) return field.slice('version:'.length)
  }
  return undefined
}

/** What is signed for `data`: its BLAKE2b-512 hash for a prehashed
 *  signature, else the data itself. */
export function signedBytes(data: Buffer, prehashed: boolean): Buffer {
  return prehashed ? createHash('blake2b512').update(data).digest() : data
}

/**
 * Verifies `tauriSignature` of `data` with `tauriPubkey` as the app does
 * with `requireSignedVersion`: the key ids match, the signature and the
 * global signature verify, and the trusted comment binds `version` (a
 * leading `v` on either side ignored). Throws with the reason otherwise;
 * answers the trusted comment.
 */
export function verifySignature(data: Buffer, tauriSignature: string, tauriPubkey: string, version: string): string {
  const key = decodePublicKey(tauriPubkey)
  const sig = decodeSignature(tauriSignature)
  if (!sig.keyIdBytes.equals(key.keyIdBytes)) {
    throw new Error(`signed with key ${keyIdHex(sig.keyIdBytes)}, not with ${key.keyId}`)
  }
  if (!verifyEd25519(null, signedBytes(data, sig.prehashed), key.key, sig.signature)) {
    throw new Error('the signature does not verify')
  }
  const global = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, 'utf8')])
  if (!verifyEd25519(null, global, key.key, sig.globalSignature)) {
    throw new Error('the trusted comment does not verify')
  }
  const signed = signedVersion(sig.trustedComment)
  if (signed === undefined) throw new Error('the signature binds no version')
  const bare = (v: string): string => v.replace(/^v/, '')
  if (bare(signed) !== bare(version)) throw new Error(`signed for version ${signed}, not ${version}`)
  return sig.trustedComment
}
