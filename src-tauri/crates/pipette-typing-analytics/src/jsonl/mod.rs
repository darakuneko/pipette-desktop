// SPDX-License-Identifier: GPL-2.0-or-later
//! The per-day JSONL masters of the typing analytics
//! (src/main/typing-analytics/jsonl/): one line per row ([`row`]), appended
//! by this device to its own day files and read back ([`reader_writer`]),
//! under `sync/keyboards/{uid}/devices/{machineHash}/` ([`paths`]).

pub mod paths;
pub mod reader_writer;
pub mod row;

pub use paths::{
    DELETED_RANGES_FILENAME, DeviceDayJsonlRef, InvalidUtcDay, deleted_ranges_applied_path,
    deleted_ranges_path, device_day_dir, device_day_jsonl_path, devices_dir, is_utc_day, keyboards_root,
    list_all_device_day_jsonl_files, list_deleted_ranges_hashes, list_device_days, utc_day_boundary_ms,
    utc_day_from_ms,
};
pub use reader_writer::{ReadResult, append_rows_to_file, read_rows};
pub use row::{
    HIST_BUCKETS, JsonlRow, RowKind, bigram_minute_row_id, char_minute_row_id, matrix_minute_row_id,
    minute_stats_row_id, scope_row_id, serialize_row, session_row_id, trigram_minute_row_id,
};
