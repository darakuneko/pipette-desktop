// SPDX-License-Identifier: GPL-2.0-or-later
//! The Drive copies of a name beyond the chosen one, moved to trash names
//! and deleted for good after the quarantine: [`tidy`], which the poll
//! pass runs on its own listing, and [`manual`], what the Data modal's
//! trash screen lists, restores and deletes.

pub mod manual;
pub mod tidy;
