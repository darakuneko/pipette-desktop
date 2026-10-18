// SPDX-License-Identifier: GPL-2.0-or-later
//! File system groundwork shared by the app and the stores: atomic writes,
//! where the userData directory is, whether this build is a distributed one
//! that takes the Electron build's directory over, and whether the Electron
//! build holds it.

mod atomic;
mod distribution;
mod electron_lock;
#[cfg(any(test, feature = "test-util"))]
pub mod test_util;
mod user_data;

pub use atomic::{write_file_atomic, write_file_atomic_keeping_owner, write_file_atomic_private};
// The temp file naming, for tests/ts_temp_names.rs.
#[doc(hidden)]
pub use atomic::{MAX_NAME_BYTES, temp_file_name};
pub use distribution::{Platform, is_distributed_build};
#[cfg(windows)]
pub use electron_lock::hold_lockfile;
pub use electron_lock::{
    ELECTRON_LOCK_FILE, ELECTRON_LOCKFILE, LockHolder, LockfileError, electron_lock_holder,
};
pub use user_data::{
    ELECTRON_USER_DATA_NAME, MIGRATION_USER_DATA_NAME, USER_DATA_DIR_ENV, UserDataError, user_data_dir,
    user_data_override,
};
