import type { VialAPI } from '../shared/types/vial-api'
import type React from 'react'

declare global {
  // `declare const` at module top-level (this file is a module because of
  // the `import type` above) is scoped to the module, not global — these
  // two esbuild-injected `define` constants (see electron.vite.config.ts /
  // vitest.config.ts) need to be visible from any renderer file, so they
  // live inside this block instead.
  const __APP_VERSION__: string
  const __BUILD_TIME__: string

  interface Window {
    vialAPI: VialAPI
  }

  // Vite's own ambient types (`vite/client`) aren't reliably resolvable
  // here — `vite` is only a transitive dependency of electron-vite/vitest,
  // not a direct one, so pnpm doesn't expose `node_modules/vite` at the
  // project root for a `/// <reference types="vite/client" />` to resolve.
  // Declare just the two surfaces the renderer actually touches instead of
  // adding a direct `vite` devDependency (which risks electron-vite's
  // build resolving a different vite instance than the one it bundles).
  interface ImportMetaEnv {
    readonly VITE_APP_VERSION?: string
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv
  }

  // @types/react 19 moved JSX typing into the `React.JSX` namespace and no
  // longer declares a global `JSX` namespace (the old implicit-global
  // behavior). This codebase annotates return types as bare `JSX.Element`
  // throughout, so re-establish the global alias once here instead of
  // rewriting every call site to `React.JSX.Element`.
  namespace JSX {
    type Element = React.JSX.Element
    type ElementType = React.JSX.ElementType
    type ElementClass = React.JSX.ElementClass
    type ElementAttributesProperty = React.JSX.ElementAttributesProperty
    type ElementChildrenAttribute = React.JSX.ElementChildrenAttribute
    type LibraryManagedAttributes<C, P> = React.JSX.LibraryManagedAttributes<C, P>
    type IntrinsicAttributes = React.JSX.IntrinsicAttributes
    type IntrinsicClassAttributes<T> = React.JSX.IntrinsicClassAttributes<T>
    type IntrinsicElements = React.JSX.IntrinsicElements
  }
}
