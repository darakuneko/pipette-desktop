// SPDX-License-Identifier: GPL-2.0-or-later
// Zip archives built byte by byte, for the cases fflate's zipSync cannot
// write: repeated names, raw name bytes with or without the UTF-8 flag,
// unknown methods, sizes that do not match the data, zip64 records and
// trailing bytes after the end record.

export interface RawEntry {
  name: Uint8Array
  /** General purpose flags; 0x800 marks a UTF-8 name. */
  flags?: number
  /** 0 stored, 8 DEFLATE, anything else unknown. */
  method: number
  /** The bytes as stored in the archive (already compressed for 8). */
  data: Uint8Array
  /** The declared size after unpacking. */
  size: number
  /** Write the sizes as 0xFFFFFFFF with a zip64 extra field. */
  zip64Sizes?: boolean
}

class Writer {
  private readonly bytes: number[] = []

  get length(): number {
    return this.bytes.length
  }

  u16(value: number): void {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff)
  }

  u32(value: number): void {
    this.u16(value & 0xffff)
    this.u16(value >>> 16)
  }

  u64(value: number): void {
    this.u32(value >>> 0)
    this.u32(Math.floor(value / 0x1_0000_0000))
  }

  raw(data: ArrayLike<number>): void {
    for (let i = 0; i < data.length; i++) this.bytes.push(data[i])
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }
}

/** A zip of `entries` followed by `trailing` bytes (the comment length in
 *  the end record stays 0); with `zip64`, a zip64 end record and locator
 *  come before the end record, which then holds 0xFFFF / 0xFFFFFFFF. */
export function buildZip(entries: RawEntry[], options: { zip64?: boolean; trailing?: Uint8Array } = {}): Uint8Array {
  const out = new Writer()
  const offsets: number[] = []
  for (const entry of entries) {
    offsets.push(out.length)
    out.u32(0x04034b50)
    out.u16(20)
    out.u16(entry.flags ?? 0)
    out.u16(entry.method)
    out.raw(new Uint8Array(8))
    out.u32(entry.data.length)
    out.u32(entry.size)
    out.u16(entry.name.length)
    out.u16(0)
    out.raw(entry.name)
    out.raw(entry.data)
  }
  const directory = out.length
  entries.forEach((entry, index) => {
    const extra = new Writer()
    if (entry.zip64Sizes) {
      extra.u16(1)
      extra.u16(16)
      extra.u64(entry.size)
      extra.u64(entry.data.length)
    }
    out.u32(0x02014b50)
    out.u16(20)
    out.u16(20)
    out.u16(entry.flags ?? 0)
    out.u16(entry.method)
    out.raw(new Uint8Array(8))
    out.u32(entry.zip64Sizes ? 0xffffffff : entry.data.length)
    out.u32(entry.zip64Sizes ? 0xffffffff : entry.size)
    out.u16(entry.name.length)
    out.u16(extra.length)
    // Comment length, disk, internal and external attributes.
    out.raw(new Uint8Array(10))
    out.u32(offsets[index])
    out.raw(entry.name)
    out.raw(extra.toBytes())
  })
  const directoryLength = out.length - directory
  if (options.zip64) {
    const record = out.length
    out.u32(0x06064b50)
    out.u64(44)
    out.raw([20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    out.u64(entries.length)
    out.u64(entries.length)
    out.u64(directoryLength)
    out.u64(directory)
    out.u32(0x07064b50)
    out.u32(0)
    out.u64(record)
    out.u32(1)
  }
  out.u32(0x06054b50)
  out.raw(new Uint8Array(4))
  const count = options.zip64 ? 0xffff : entries.length
  out.u16(count)
  out.u16(count)
  out.u32(directoryLength)
  out.u32(options.zip64 ? 0xffffffff : directory)
  out.u16(0)
  if (options.trailing) out.raw(options.trailing)
  return out.toBytes()
}
