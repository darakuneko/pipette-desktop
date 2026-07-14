// Static asset import — mirrors vite/client's built-in `*.png` module shape
// (see env.d.ts for why this isn't just `/// <reference types="vite/client" />`).
// Must stay a global script (no top-level import/export): a wildcard
// `declare module` only takes ambient effect project-wide when it lives in
// a non-module file — inside a module file it silently applies only to
// that file's own imports instead of globally.
declare module '*.png' {
  const src: string
  export default src
}

// Vite's `?url` suffix resolves any import to its built asset URL string —
// used for the pdf.js worker script, which must be loaded from a URL rather
// than bundled as a module.
declare module '*?url' {
  const src: string
  export default src
}
