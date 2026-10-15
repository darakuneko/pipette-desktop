// SPDX-License-Identifier: GPL-2.0-or-later
//! QMK Settings store and wire protocol.
//!
//! The field list, per-qsid width and defaults mirror vial-qmk's
//! quantum/qmk_settings.c `protos[]` table and qmk_settings_reset(). Qsids
//! 9-17 (mousekey_*) exist only with `MOUSEKEY_ENABLE && !MK_3_SPEED`; the
//! keyboard's info.json enables mousekey and nothing defines MK_3_SPEED, so
//! they are included. Qsid 8 has no slot in this vial-qmk version's
//! `protos[]` table (the ids jump from 7 to 9), so it is absent here too.

use crate::byte_utils::{read_le16, read_le32, write_le16, write_le32};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QmkSettingsStore {
    pub grave_esc_override: u8,
    pub combo_term: u16,
    pub auto_shift: u8,
    pub auto_shift_timeout: u16,
    pub osk_tap_toggle: u8,
    pub osk_timeout: u16,
    pub tapping_term: u16,
    pub mousekey_delay: u16,
    pub mousekey_interval: u16,
    pub mousekey_move_delta: u16,
    pub mousekey_max_speed: u16,
    pub mousekey_time_to_max: u16,
    pub mousekey_wheel_delay: u16,
    pub mousekey_wheel_interval: u16,
    pub mousekey_wheel_max_speed: u16,
    pub mousekey_wheel_time_to_max: u16,
    pub tap_code_delay: u16,
    pub tap_hold_caps_delay: u16,
    pub tapping_toggle: u8,
    /// Magic-settings bit flags (mod swaps, NKRO, ...) — qsid 21.
    pub magic_flags: u32,
    /// Bitfield behind qsids 22/23/24/26 (permissive hold / hold on other
    /// key press / retro tapping / chordal hold).
    pub tapping_v2: u8,
    pub quick_tap_term: u16,
    pub flow_tap_term: u16,
}

impl Default for QmkSettingsStore {
    fn default() -> Self {
        Self {
            grave_esc_override: 0,
            combo_term: 50, // quantum/process_keycode/process_combo.h COMBO_TERM
            auto_shift: 0,
            auto_shift_timeout: 175, // quantum/process_keycode/process_auto_shift.h AUTO_SHIFT_TIMEOUT
            osk_tap_toggle: 5,       // qmk_settings.h ONESHOT_TAP_TOGGLE
            osk_timeout: 5000,       // qmk_settings.h ONESHOT_TIMEOUT
            tapping_term: 200,       // quantum/action_tapping.h TAPPING_TERM
            mousekey_delay: 10, // quantum/mousekey.h MOUSEKEY_DELAY (no MK_3_SPEED/MK_KINETIC_SPEED/MOUSEKEY_INERTIA)
            mousekey_interval: 20, // MOUSEKEY_INTERVAL
            mousekey_move_delta: 8, // MOUSEKEY_MOVE_DELTA
            mousekey_max_speed: 10, // MOUSEKEY_MAX_SPEED
            mousekey_time_to_max: 30, // MOUSEKEY_TIME_TO_MAX
            mousekey_wheel_delay: 10, // MOUSEKEY_WHEEL_DELAY
            mousekey_wheel_interval: 80, // MOUSEKEY_WHEEL_INTERVAL
            mousekey_wheel_max_speed: 8, // MOUSEKEY_WHEEL_MAX_SPEED
            mousekey_wheel_time_to_max: 40, // MOUSEKEY_WHEEL_TIME_TO_MAX
            // quantum/action.h TAP_CODE_DELAY: qmk_settings.h includes action.h
            // before its own #ifndef fallback (10), so action.h's 0 wins.
            tap_code_delay: 0,
            tap_hold_caps_delay: 80, // qmk_settings.h TAP_HOLD_CAPS_DELAY
            tapping_toggle: 5,       // quantum/action_tapping.h TAPPING_TOGGLE
            magic_flags: 0,
            tapping_v2: 0,
            quick_tap_term: 200, // qmk_settings_reset(): QS.quick_tap_term = TAPPING_TERM
            flow_tap_term: 0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Field {
    GraveEscOverride,
    ComboTerm,
    AutoShift,
    AutoShiftTimeout,
    OskTapToggle,
    OskTimeout,
    TappingTerm,
    MousekeyDelay,
    MousekeyInterval,
    MousekeyMoveDelta,
    MousekeyMaxSpeed,
    MousekeyTimeToMax,
    MousekeyWheelDelay,
    MousekeyWheelInterval,
    MousekeyWheelMaxSpeed,
    MousekeyWheelTimeToMax,
    TapCodeDelay,
    TapHoldCapsDelay,
    TappingToggle,
    MagicFlags,
    QuickTapTerm,
    FlowTapTerm,
}

/// Wire descriptor of one qsid: a scalar field, or one bit of `tapping_v2`.
#[derive(Clone, Copy, Debug)]
enum Proto {
    Scalar(Field),
    Bit(u8),
}

/// Declared in the firmware table's order, which is already qsid-ascending;
/// qmk_settings_query() walks this order.
const QSID_PROTOS: [(u16, Proto); 26] = [
    (1, Proto::Scalar(Field::GraveEscOverride)),
    (2, Proto::Scalar(Field::ComboTerm)),
    (3, Proto::Scalar(Field::AutoShift)),
    (4, Proto::Scalar(Field::AutoShiftTimeout)),
    (5, Proto::Scalar(Field::OskTapToggle)),
    (6, Proto::Scalar(Field::OskTimeout)),
    (7, Proto::Scalar(Field::TappingTerm)),
    (9, Proto::Scalar(Field::MousekeyDelay)),
    (10, Proto::Scalar(Field::MousekeyInterval)),
    (11, Proto::Scalar(Field::MousekeyMoveDelta)),
    (12, Proto::Scalar(Field::MousekeyMaxSpeed)),
    (13, Proto::Scalar(Field::MousekeyTimeToMax)),
    (14, Proto::Scalar(Field::MousekeyWheelDelay)),
    (15, Proto::Scalar(Field::MousekeyWheelInterval)),
    (16, Proto::Scalar(Field::MousekeyWheelMaxSpeed)),
    (17, Proto::Scalar(Field::MousekeyWheelTimeToMax)),
    (18, Proto::Scalar(Field::TapCodeDelay)),
    (19, Proto::Scalar(Field::TapHoldCapsDelay)),
    (20, Proto::Scalar(Field::TappingToggle)),
    (21, Proto::Scalar(Field::MagicFlags)),
    (22, Proto::Bit(0)),
    (23, Proto::Bit(1)),
    (24, Proto::Bit(2)),
    (25, Proto::Scalar(Field::QuickTapTerm)),
    (26, Proto::Bit(3)),
    (27, Proto::Scalar(Field::FlowTapTerm)),
];

/// Supported qsids in firmware-table order.
pub const SUPPORTED_QSIDS: [u16; 26] = {
    let mut out = [0u16; 26];
    let mut i = 0;
    while i < QSID_PROTOS.len() {
        out[i] = QSID_PROTOS[i].0;
        i += 1;
    }
    out
};

/// Status byte for a supported qsid.
pub const STATUS_OK: u8 = 0;
/// Status byte for an unsupported qsid.
pub const STATUS_UNSUPPORTED: u8 = 0xff;

fn find_proto(qsid: u16) -> Option<Proto> {
    QSID_PROTOS.iter().find(|(id, _)| *id == qsid).map(|(_, proto)| *proto)
}

/// A field's value with its wire width in bytes.
enum Value {
    U8(u8),
    U16(u16),
    U32(u32),
}

impl QmkSettingsStore {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    fn get_field(&self, field: Field) -> Value {
        match field {
            Field::GraveEscOverride => Value::U8(self.grave_esc_override),
            Field::ComboTerm => Value::U16(self.combo_term),
            Field::AutoShift => Value::U8(self.auto_shift),
            Field::AutoShiftTimeout => Value::U16(self.auto_shift_timeout),
            Field::OskTapToggle => Value::U8(self.osk_tap_toggle),
            Field::OskTimeout => Value::U16(self.osk_timeout),
            Field::TappingTerm => Value::U16(self.tapping_term),
            Field::MousekeyDelay => Value::U16(self.mousekey_delay),
            Field::MousekeyInterval => Value::U16(self.mousekey_interval),
            Field::MousekeyMoveDelta => Value::U16(self.mousekey_move_delta),
            Field::MousekeyMaxSpeed => Value::U16(self.mousekey_max_speed),
            Field::MousekeyTimeToMax => Value::U16(self.mousekey_time_to_max),
            Field::MousekeyWheelDelay => Value::U16(self.mousekey_wheel_delay),
            Field::MousekeyWheelInterval => Value::U16(self.mousekey_wheel_interval),
            Field::MousekeyWheelMaxSpeed => Value::U16(self.mousekey_wheel_max_speed),
            Field::MousekeyWheelTimeToMax => Value::U16(self.mousekey_wheel_time_to_max),
            Field::TapCodeDelay => Value::U16(self.tap_code_delay),
            Field::TapHoldCapsDelay => Value::U16(self.tap_hold_caps_delay),
            Field::TappingToggle => Value::U8(self.tapping_toggle),
            Field::MagicFlags => Value::U32(self.magic_flags),
            Field::QuickTapTerm => Value::U16(self.quick_tap_term),
            Field::FlowTapTerm => Value::U16(self.flow_tap_term),
        }
    }

    fn field_mut(&mut self, field: Field) -> FieldMut<'_> {
        match field {
            Field::GraveEscOverride => FieldMut::U8(&mut self.grave_esc_override),
            Field::ComboTerm => FieldMut::U16(&mut self.combo_term),
            Field::AutoShift => FieldMut::U8(&mut self.auto_shift),
            Field::AutoShiftTimeout => FieldMut::U16(&mut self.auto_shift_timeout),
            Field::OskTapToggle => FieldMut::U8(&mut self.osk_tap_toggle),
            Field::OskTimeout => FieldMut::U16(&mut self.osk_timeout),
            Field::TappingTerm => FieldMut::U16(&mut self.tapping_term),
            Field::MousekeyDelay => FieldMut::U16(&mut self.mousekey_delay),
            Field::MousekeyInterval => FieldMut::U16(&mut self.mousekey_interval),
            Field::MousekeyMoveDelta => FieldMut::U16(&mut self.mousekey_move_delta),
            Field::MousekeyMaxSpeed => FieldMut::U16(&mut self.mousekey_max_speed),
            Field::MousekeyTimeToMax => FieldMut::U16(&mut self.mousekey_time_to_max),
            Field::MousekeyWheelDelay => FieldMut::U16(&mut self.mousekey_wheel_delay),
            Field::MousekeyWheelInterval => FieldMut::U16(&mut self.mousekey_wheel_interval),
            Field::MousekeyWheelMaxSpeed => FieldMut::U16(&mut self.mousekey_wheel_max_speed),
            Field::MousekeyWheelTimeToMax => FieldMut::U16(&mut self.mousekey_wheel_time_to_max),
            Field::TapCodeDelay => FieldMut::U16(&mut self.tap_code_delay),
            Field::TapHoldCapsDelay => FieldMut::U16(&mut self.tap_hold_caps_delay),
            Field::TappingToggle => FieldMut::U8(&mut self.tapping_toggle),
            Field::MagicFlags => FieldMut::U32(&mut self.magic_flags),
            Field::QuickTapTerm => FieldMut::U16(&mut self.quick_tap_term),
            Field::FlowTapTerm => FieldMut::U16(&mut self.flow_tap_term),
        }
    }
}

enum FieldMut<'a> {
    U8(&'a mut u8),
    U16(&'a mut u16),
    U32(&'a mut u32),
}

/// Fill `buf` with the qsids greater than `qsid_greater_than`, LE16-encoded
/// from offset 0, after filling the whole buffer with 0xff — the same as
/// qmk_settings_query(). Unlike get/set, the buffer is the whole response.
pub fn qmk_settings_query(qsid_greater_than: u16, buf: &mut [u8]) {
    buf.fill(0xff);
    let mut offset = 0;
    for qsid in SUPPORTED_QSIDS {
        if offset + 2 > buf.len() {
            break;
        }
        if qsid > qsid_greater_than {
            write_le16(buf, offset, qsid);
            offset += 2;
        }
    }
}

/// Write the value at `buf[offset..]`. Returns STATUS_OK, or
/// STATUS_UNSUPPORTED with `buf` untouched.
pub fn qmk_settings_get(store: &QmkSettingsStore, qsid: u16, buf: &mut [u8], offset: usize) -> u8 {
    let Some(proto) = find_proto(qsid) else {
        return STATUS_UNSUPPORTED;
    };
    match proto {
        Proto::Bit(bit) => buf[offset] = (store.tapping_v2 >> bit) & 1,
        Proto::Scalar(field) => match store.get_field(field) {
            Value::U8(v) => buf[offset] = v,
            Value::U16(v) => write_le16(buf, offset, v),
            Value::U32(v) => write_le32(buf, offset, v),
        },
    }
    STATUS_OK
}

/// Read the value from `buf[offset..]`. Returns STATUS_OK, or
/// STATUS_UNSUPPORTED with the store untouched.
pub fn qmk_settings_set(store: &mut QmkSettingsStore, qsid: u16, buf: &[u8], offset: usize) -> u8 {
    let Some(proto) = find_proto(qsid) else {
        return STATUS_UNSUPPORTED;
    };
    match proto {
        Proto::Bit(bit) => {
            if buf[offset] & 1 != 0 {
                store.tapping_v2 |= 1 << bit;
            } else {
                store.tapping_v2 &= !(1 << bit);
            }
        }
        Proto::Scalar(field) => match store.field_mut(field) {
            FieldMut::U8(v) => *v = buf[offset],
            FieldMut::U16(v) => *v = read_le16(buf, offset),
            FieldMut::U32(v) => *v = read_le32(buf, offset),
        },
    }
    STATUS_OK
}
