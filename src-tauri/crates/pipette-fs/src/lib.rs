// SPDX-License-Identifier: GPL-2.0-or-later
//! File system groundwork shared by the app and the stores: atomic writes,
//! where the userData directory is, whether this build is a distributed one
//! that takes the 0.4 build's directory over, whether the 0.4
//! build holds it, and the removal of what the 0.4 build left in it.

mod atomic;
mod distribution;
#[cfg(any(test, feature = "test-util"))]
pub mod test_util;
mod user_data;
mod v04_leftovers;
mod v04_lock;

pub use atomic::{write_file_atomic, write_file_atomic_keeping_owner, write_file_atomic_private};
// The temp file naming, for tests/ts_temp_names.rs.
#[doc(hidden)]
pub use atomic::{MAX_NAME_BYTES, temp_file_name};
pub use distribution::{Platform, is_appimage_run, is_distributed_build};
pub use user_data::{
    MIGRATION_USER_DATA_NAME, USER_DATA_DIR_ENV, UserDataError, V04_USER_DATA_NAME, user_data_dir,
    user_data_override,
};
pub use v04_leftovers::remove_v04_leftovers;
#[cfg(windows)]
pub use v04_lock::hold_lockfile;
pub use v04_lock::{LockHolder, LockfileError, V04_LOCK_FILE, V04_LOCKFILE, v04_lock_holder};
