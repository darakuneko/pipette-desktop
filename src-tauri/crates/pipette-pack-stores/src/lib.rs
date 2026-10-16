// SPDX-License-Identifier: GPL-2.0-or-later
//! The pack stores under the userData directory, writing the same files as
//! the Electron build:
//!
//! - the layer the language and theme packs share ([`PackStore`]): the
//!   index and the body files of a store, its write lock and sync units,
//!   the v1 metas' body clock, the name lookup, the reorder, the three-state
//!   fields of a save ([`Field`]), the files of an import dialog
//!   ([`read_import_file`]) and the `{success, data | errorCode, error}`
//!   answers ([`response_json`]);
//! - the operations on a meta both stores share (`pack_meta`: the save's
//!   id and name, rename, Hub link, delete) and what their handlers share
//!   (`handlers`: the arguments and the export);
//! - the language packs (`sync/i18n`, [`i18n`]) of
//!   src/main/i18n-pack-store*.ts, and their handlers
//!   ([`i18n_handlers`]) of src/main/i18n-pack-ipc.ts;
//! - the theme packs (`sync/themes`, [`theme`]) of
//!   src/main/theme-pack-store.ts, and their handlers ([`theme_handlers`])
//!   of src/main/theme-pack-ipc.ts.
//!
//! The stores work through the [`StoreContext`] every store of the app
//! shares: the userData directory, the clock, the ids of new packs, the
//! write locks and the change notifier.
//!
//! [`StoreContext`]: pipette_keyboard_stores::StoreContext

pub mod handlers;
pub mod i18n;
pub mod i18n_handlers;
mod import_file;
mod js_text;
mod pack_meta;
mod pack_store;
mod result;
pub mod theme;
pub mod theme_handlers;

pub use import_file::{ImportFileRead, read_import_file};
pub use pack_meta::Cached;
pub use pack_store::{Field, PackIndex, PackStore, find_active_by_name};
pub use result::{ErrorCode, PackError, PackResult, response, response_json};
