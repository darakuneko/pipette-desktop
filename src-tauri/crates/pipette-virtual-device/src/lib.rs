// SPDX-License-Identifier: GPL-2.0-or-later
//! Software emulation of a Vial keyboard ("Virtual Keyboard", GPK60-63R
//! layout) for development, tests and documentation screenshots.
//!
//! The device answers raw 32-byte HID reports exactly like the firmware it
//! models (VIA protocol 9, Vial protocol 6, VialRGB). The current time is
//! always passed in by the caller so the unlock state machine stays
//! deterministic under test.
//!
//! Keycode values are not computed here: the default keymap, sample entries
//! and named keycodes are generated from the TypeScript keycode tables
//! (`data/default_dataset.rs`), and the keyboard definition is embedded
//! already LZMA-compressed (`data/definition.lzma`).

pub mod byte_utils;
pub mod controller;
pub mod dataset;
pub mod device;
pub mod dynamic_entries;
pub mod mode;
pub mod protocol;
pub mod qmk_settings;
pub mod state;
pub mod via_handler;
pub mod vial_handler;
pub mod vialrgb_handler;

pub use controller::{ControllerState, VirtualDeviceController};
pub use device::{NotOpenError, VirtualDevice};
pub use mode::VirtualDeviceMode;
pub use protocol::{MSG_LEN, Report};
