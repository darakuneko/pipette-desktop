// SPDX-License-Identifier: GPL-2.0-or-later
//! The Local Data export and import of the Data modal: a JSON file of the
//! favorites, snapshots and settings, and its merge back into the local stores.
//! The dialogs are the caller's.

mod export;
mod import;

pub use export::{collect_export_categories, export_default_filename, export_text};
pub use import::{LocalDataImportError, import_local_data};
