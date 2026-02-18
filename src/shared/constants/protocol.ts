// USB HID parameters
export const MSG_LEN = 32
export const BUFFER_FETCH_CHUNK = 28
export const HID_USAGE_PAGE = 0xff60
export const HID_USAGE = 0x61
export const HID_REPORT_ID = 0x00

// Device detection magic strings
export const VIAL_SERIAL_MAGIC = 'vial:f64c2b3c'
export const BOOTLOADER_SERIAL_MAGIC = 'vibl:d4f8159c'

// Communication parameters
export const HID_TIMEOUT_MS = 500
export const HID_RETRY_COUNT = 20
export const HID_RETRY_DELAY_MS = 500
export const HID_OPEN_RETRY_COUNT = 10
export const HID_OPEN_RETRY_DELAY_MS = 1000
export const ECHO_RETRY_COUNT = 3
export const ECHO_RETRY_DELAY_MS = 500
export const ECHO_DETECTED_MSG = 'ECHO_DETECTED'

// Sample keyboard UIDs (must not be shipped)
export const EXAMPLE_UIDS = [
  0xd4a36200603e3007n,
  0x32f62bc2eef2237bn,
  0x38cea320f23046a5n,
  0xbed2d31ec59a0bd8n,
]
export const EXAMPLE_UID_PREFIX = 0xa6867bdfd3b00fn

// --- VIA Protocol Commands ---
export const CMD_VIA_GET_PROTOCOL_VERSION = 0x01
export const CMD_VIA_GET_KEYBOARD_VALUE = 0x02
export const CMD_VIA_SET_KEYBOARD_VALUE = 0x03
export const CMD_VIA_GET_KEYCODE = 0x04
export const CMD_VIA_SET_KEYCODE = 0x05
export const CMD_VIA_LIGHTING_SET_VALUE = 0x07
export const CMD_VIA_LIGHTING_GET_VALUE = 0x08
export const CMD_VIA_LIGHTING_SAVE = 0x09
export const CMD_VIA_MACRO_GET_COUNT = 0x0c
export const CMD_VIA_MACRO_GET_BUFFER_SIZE = 0x0d
export const CMD_VIA_MACRO_GET_BUFFER = 0x0e
export const CMD_VIA_MACRO_SET_BUFFER = 0x0f
export const CMD_VIA_GET_LAYER_COUNT = 0x11
export const CMD_VIA_KEYMAP_GET_BUFFER = 0x12
export const CMD_VIA_VIAL_PREFIX = 0xfe

// --- VIA Keyboard Value subcommands ---
export const VIA_LAYOUT_OPTIONS = 0x02
export const VIA_SWITCH_MATRIX_STATE = 0x03

// --- Lighting subcommands ---
export const QMK_BACKLIGHT_BRIGHTNESS = 0x09
export const QMK_BACKLIGHT_EFFECT = 0x0a
export const QMK_RGBLIGHT_BRIGHTNESS = 0x80
export const QMK_RGBLIGHT_EFFECT = 0x81
export const QMK_RGBLIGHT_EFFECT_SPEED = 0x82
export const QMK_RGBLIGHT_COLOR = 0x83
export const VIALRGB_GET_INFO = 0x40
export const VIALRGB_GET_MODE = 0x41
export const VIALRGB_GET_SUPPORTED = 0x42
export const VIALRGB_SET_MODE = 0x41

// --- Vial Protocol Commands (sent after CMD_VIA_VIAL_PREFIX) ---
export const CMD_VIAL_GET_KEYBOARD_ID = 0x00
export const CMD_VIAL_GET_SIZE = 0x01
export const CMD_VIAL_GET_DEFINITION = 0x02
export const CMD_VIAL_GET_ENCODER = 0x03
export const CMD_VIAL_SET_ENCODER = 0x04
export const CMD_VIAL_GET_UNLOCK_STATUS = 0x05
export const CMD_VIAL_UNLOCK_START = 0x06
export const CMD_VIAL_UNLOCK_POLL = 0x07
export const CMD_VIAL_LOCK = 0x08
export const CMD_VIAL_QMK_SETTINGS_QUERY = 0x09
export const CMD_VIAL_QMK_SETTINGS_GET = 0x0a
export const CMD_VIAL_QMK_SETTINGS_SET = 0x0b
export const CMD_VIAL_QMK_SETTINGS_RESET = 0x0c
export const CMD_VIAL_DYNAMIC_ENTRY_OP = 0x0d

// --- Dynamic Entry subcommands ---
export const DYNAMIC_VIAL_GET_NUMBER_OF_ENTRIES = 0x00
export const DYNAMIC_VIAL_TAP_DANCE_GET = 0x01
export const DYNAMIC_VIAL_TAP_DANCE_SET = 0x02
export const DYNAMIC_VIAL_COMBO_GET = 0x03
export const DYNAMIC_VIAL_COMBO_SET = 0x04
export const DYNAMIC_VIAL_KEY_OVERRIDE_GET = 0x05
export const DYNAMIC_VIAL_KEY_OVERRIDE_SET = 0x06
export const DYNAMIC_VIAL_ALT_REPEAT_KEY_GET = 0x07
export const DYNAMIC_VIAL_ALT_REPEAT_KEY_SET = 0x08

// --- Macro action codes ---
export const SS_QMK_PREFIX = 0x01
export const SS_TAP_CODE = 0x01
export const SS_DOWN_CODE = 0x02
export const SS_UP_CODE = 0x03
export const SS_DELAY_CODE = 0x04
export const VIAL_MACRO_EXT_TAP = 0x05
export const VIAL_MACRO_EXT_DOWN = 0x06
export const VIAL_MACRO_EXT_UP = 0x07

// --- Protocol version ranges ---
export const SUPPORTED_VIA_PROTOCOLS = [-1, 9]
export const SUPPORTED_VIAL_PROTOCOLS = [-1, 0, 1, 2, 3, 4, 5, 6]

// --- Protocol version feature gates ---
export const VIAL_PROTOCOL_ADVANCED_MACROS = 2
export const VIAL_PROTOCOL_MATRIX_TESTER = 3
export const VIAL_PROTOCOL_DYNAMIC = 4
export const VIAL_PROTOCOL_QMK_SETTINGS = 4
export const VIAL_PROTOCOL_EXT_MACROS = 5
export const VIAL_PROTOCOL_KEY_OVERRIDE = 5
