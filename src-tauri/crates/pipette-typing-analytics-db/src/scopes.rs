// SPDX-License-Identifier: GPL-2.0-or-later
//! The reads over the scopes:
//! the keyboards this device recorded and the other devices of a keyboard.

use crate::query::{Params, all, column};
use crate::rows::RemoteDeviceInfo;
use crate::{Error, TypingAnalyticsDb, sql};

impl TypingAnalyticsDb {
    /// The keyboard uids of the live scopes of `machine_hash`
    /// (`listLocalKeyboardUids`).
    pub fn local_keyboard_uids(&self, machine_hash: &str) -> Result<Vec<String>, Error> {
        let params: Params<'_> = vec![("@machineHash", &machine_hash)];
        all(&self.conn, sql::SELECT_LOCAL_KEYBOARD_UIDS, &params, |row| column(row, 0, "keyboardUid"))
    }

    /// The devices other than `own_hash` with live minute stats for `uid`,
    /// each with the OS of its latest scope, by hash
    /// (`listRemoteDeviceInfosForUid`).
    pub fn remote_device_infos(&self, uid: &str, own_hash: &str) -> Result<Vec<RemoteDeviceInfo>, Error> {
        let params: Params<'_> = vec![("@uid", &uid), ("@ownHash", &own_hash)];
        all(&self.conn, sql::SELECT_REMOTE_HASHES_FOR_UID, &params, RemoteDeviceInfo::from_row)
    }
}
