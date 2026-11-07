// SPDX-License-Identifier: GPL-2.0-or-later

export interface KeycodeOptions {
  qmkId: string
  label: string
  tooltip?: string
  /** i18n key for `tooltip`; `tooltip` stays the English fallback. Left
   *  unset for text the app does not own (customKeycodes titles). */
  tooltipKey?: string
  /** Interpolation values for `tooltipKey` (e.g. `{ layer: 2 }`). */
  tooltipParams?: Record<string, string | number>
  masked?: boolean
  printable?: string
  recorderAlias?: string[]
  alias?: string[]
  requiresFeature?: string
  /** Preferred name for keymap.c export (standard QMK name). Falls back to qmkId. */
  cExportId?: string
}

export interface CustomKeycodeDefinition {
  name?: string
  title?: string
  shortName?: string
}

export interface KeyboardKeycodeContext {
  vialProtocol: number
  layers: number
  macroCount: number
  tapDanceCount: number
  customKeycodes: CustomKeycodeDefinition[] | null
  midi: string
  supportedFeatures: Set<string>
}
