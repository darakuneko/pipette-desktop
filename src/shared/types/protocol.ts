/** Device type classification */
export type DeviceType = 'vial' | 'via' | 'bootloader'

/** Detected HID device info */
export interface DeviceInfo {
  vendorId: number
  productId: number
  productName: string
  serialNumber: string
  type: DeviceType
}

/** Keyboard identity from CMD_VIAL_GET_KEYBOARD_ID */
export interface KeyboardId {
  vialProtocol: number
  /** Stored as hex string to avoid IPC BigInt issues */
  uid: string
}

/** Keyboard definition decoded from LZMA-compressed JSON */
export interface KeyboardDefinition {
  name?: string
  matrix: { rows: number; cols: number }
  layouts: {
    labels?: (string | string[])[]
    keymap: unknown[][]
  }
  lighting?: string
  customKeycodes?: { name: string; title: string; shortName: string }[]
  vial?: { midi?: string }
  /** QMK dynamic_keymap config — layer_count overrides dummy layer count (default: 4) */
  dynamic_keymap?: { layer_count?: number }
}

/** Tap Dance entry */
export interface TapDanceEntry {
  onTap: number
  onHold: number
  onDoubleTap: number
  onTapHold: number
  tappingTerm: number
}

/** Combo entry */
export interface ComboEntry {
  key1: number
  key2: number
  key3: number
  key4: number
  output: number
}

/** Key Override options bit flags */
export enum KeyOverrideOptions {
  ActivationTriggerDown = 1 << 0,
  ActivationRequired = 1 << 1,
  ActivationNegativeModUp = 1 << 2,
  OneShot = 1 << 3,
  NoReregister = 1 << 4,
  NoUnregisterOnOther = 1 << 5,
}

/** Key Override entry */
export interface KeyOverrideEntry {
  triggerKey: number
  replacementKey: number
  layers: number
  triggerMods: number
  negativeMods: number
  suppressedMods: number
  options: number
  enabled: boolean
}

/** Alt Repeat Key options bit flags */
export enum AltRepeatKeyOptions {
  DefaultToThisAltKey = 1 << 0,
  Bidirectional = 1 << 1,
  IgnoreModHandedness = 1 << 2,
}

/** Alt Repeat Key entry */
export interface AltRepeatKeyEntry {
  lastKey: number
  altKey: number
  allowedMods: number
  options: number
  enabled: boolean
}

/** Dynamic entry counts */
export interface DynamicEntryCounts {
  tapDance: number
  combo: number
  keyOverride: number
  altRepeatKey: number
  featureFlags: number
}

/** Unlock status */
export interface UnlockStatus {
  unlocked: boolean
  inProgress: boolean
  keys: [number, number][]
}

/** QMK Settings field definition */
export interface QmkSettingsField {
  type: 'boolean' | 'integer'
  title: string
  qsid: number
  width?: number
  bit?: number
  min?: number
  max?: number
}

/** QMK Settings tab */
export interface QmkSettingsTab {
  name: string
  fields: QmkSettingsField[]
}

/**
 * .vil / .pipette file format for save/restore.
 *
 * Version history:
 *   v1 (implicit) — original format, no `version` field, no `definition`.
 *   v2 — adds `version: 2` and embeds `KeyboardDefinition` so the snapshot
 *         can render a virtual keyboard without a physical device connected.
 */
export interface VilFile {
  /** Format version. Absent in legacy v1 files; 2 for current format. */
  version?: number
  uid: string
  keymap: Record<string, number>
  encoderLayout: Record<string, number>
  macros: number[]
  macroJson?: unknown[][]
  layoutOptions: number
  tapDance: TapDanceEntry[]
  combo: ComboEntry[]
  keyOverride: KeyOverrideEntry[]
  altRepeatKey: AltRepeatKeyEntry[]
  qmkSettings: Record<string, number[]>
  layerNames?: string[]
  /** VIA protocol version. */
  viaProtocol?: number
  /** Vial protocol version — determines keycode address table (v5 vs v6). */
  vialProtocol?: number
  /** Feature flags bitmask (caps_word, layer_lock). */
  featureFlags?: number
  /** Keyboard definition embedded in v2 snapshots for offline rendering. */
  definition?: KeyboardDefinition
}

/** Result of probing a connected keyboard device */
export interface ProbeResult {
  uid: string
  name: string
  vialProtocol: number
  definition: KeyboardDefinition
  layers: number
  rows: number
  cols: number
  keymap: Record<string, number>      // "layer,row,col" → keycode
  encoderLayout: Record<string, number> // "layer,idx,dir" → keycode
  encoderCount: number
  layoutOptions: number
}
