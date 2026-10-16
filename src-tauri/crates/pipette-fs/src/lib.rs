// SPDX-License-Identifier: GPL-2.0-or-later
//! File system groundwork shared by the app and the stores: atomic writes,
//! where the userData directory is, and whether the Electron build holds it.

mod atomic;
mod electron_lock;
mod user_data;

pub use atomic::{write_file_atomic, write_file_atomic_keeping_owner, write_file_atomic_private};
// The temp file naming, for tests/ts_temp_names.rs.
#[doc(hidden)]
pub use atomic::{MAX_NAME_BYTES, temp_file_name};
pub use electron_lock::{LockHolder, electron_lock_holder};
pub use user_data::{ELECTRON_USER_DATA_NAME, UserDataError, user_data_dir};
