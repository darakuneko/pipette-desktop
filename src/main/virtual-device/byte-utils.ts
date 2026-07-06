// SPDX-License-Identifier: GPL-2.0-or-later
// Shared big-endian / little-endian byte helpers for the virtual device
// protocol handlers. Endianness mixing follows the real firmware/preload
// contract documented in src/preload/protocol.ts.

export function readBE16(buf: Uint8Array, offset: number): number {
  return (buf[offset] << 8) | buf[offset + 1]
}

export function writeBE16(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >> 8) & 0xff
  buf[offset + 1] = value & 0xff
}

export function readBE32(buf: Uint8Array, offset: number): number {
  return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0
}

export function writeBE32(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff
  buf[offset + 1] = (value >>> 16) & 0xff
  buf[offset + 2] = (value >>> 8) & 0xff
  buf[offset + 3] = value & 0xff
}

export function readLE16(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8)
}

export function writeLE16(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >> 8) & 0xff
}

export function writeLE32(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >> 8) & 0xff
  buf[offset + 2] = (value >> 16) & 0xff
  buf[offset + 3] = (value >> 24) & 0xff
}
