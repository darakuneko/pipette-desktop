// SPDX-License-Identifier: GPL-2.0-or-later
//! The deleted ranges of a device's typing data: the file's model
//! ([`model`]) and its store ([`store`]).

pub mod model;
pub mod store;

pub use model::{
    DeletedRangeEntry, DeletedRangesUnion, InvalidLocalDay, clip_to_utc_day, deleted_range_for_all,
    deleted_ranges_for_local_days, parse_deleted_ranges_file, serialize_deleted_ranges, union_deleted_ranges,
};
pub use store::{
    DeletedRangesError, bundle_deleted_ranges, read_applied_ids, read_deleted_ranges,
    read_deleted_ranges_lenient, update_deleted_ranges, write_applied_ids,
};
