// SPDX-License-Identifier: GPL-2.0-or-later
// Type declarations for the decompress-only build of the 'lzma' package
// (lzma-js). The file is a script that assigns to `this`; bundled as
// CommonJS, its exports object carries the decoder as LZMA.

declare module 'lzma/src/lzma-d.js' {
  interface LzmaDecoder {
    decompress(
      data: number[],
      on_finish: (result: string | number[] | null, error?: unknown) => void,
      on_progress?: (percent: number) => void,
    ): void
  }
  const lzmaD: { LZMA: LzmaDecoder }
  export default lzmaD
}
