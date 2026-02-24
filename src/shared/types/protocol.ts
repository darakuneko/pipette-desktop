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

/** .vil file format for save/restore */
export interface VilFile {
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
}
