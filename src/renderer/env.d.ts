/// <reference types="vite/client" />

import type { VialAPI } from '../shared/types/vial-api'

declare const __APP_VERSION__: string
declare const __BUILD_TIME__: string

declare global {
  interface Window {
    vialAPI: VialAPI
  }
}
