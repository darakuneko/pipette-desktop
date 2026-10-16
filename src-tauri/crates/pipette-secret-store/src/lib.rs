// SPDX-License-Identifier: GPL-2.0-or-later
//! The sync's secrets at rest, in place of Electron's `safeStorage`
//! (src/main/sync/sync-secret-file.ts): a master key in the OS key store
//! and the files of `local/auth/` encrypted with it. Empty until the
//! secrets move here.
