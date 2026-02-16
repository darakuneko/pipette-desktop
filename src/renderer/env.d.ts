/// <reference types="vite/client" />

import type { VialAPI } from '../shared/types/vial-api'

declare global {
  interface Window {
    vialAPI: VialAPI
  }
}
