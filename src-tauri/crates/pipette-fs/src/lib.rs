// SPDX-License-Identifier: GPL-2.0-or-later
//! File system groundwork shared by the app and the stores: atomic writes,
//! where the userData directory is, and whether the Electron build holds it.

mod atomic;
mod electron_lock;
mod user_data;

pub use atomic::{MAX_NAME_BYTES, temp_file_name, write_file_atomic};
pub use electron_lock::{ELECTRON_LOCK_FILE, LockHolder, electron_lock_holder};
pub use user_data::{
    ELECTRON_USER_DATA_NAME, MIGRATION_USER_DATA_NAME, USER_DATA_DIR_ENV, UserDataError,
    resolve_user_data_dir, user_data_dir,
};
