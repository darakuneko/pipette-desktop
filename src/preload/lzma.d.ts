/** Type declarations for the 'lzma' package (lzma-js). */
declare module 'lzma' {
  interface LZMA {
    compress(
      data: string | number[],
      mode: number,
      on_finish: (result: number[]) => void,
      on_progress?: (percent: number) => void,
    ): void
    decompress(
      data: number[],
      on_finish: (result: string | null) => void,
      on_progress?: (percent: number) => void,
    ): void
  }
  const LZMA: LZMA
  export default LZMA
}
