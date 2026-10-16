// SPDX-License-Identifier: GPL-2.0-or-later
//! The typing analytics of the Electron build's src/main/typing-analytics/
//! above the SQLite layer (`pipette-typing-analytics-db`): who recorded
//! the data ([`identity`], [`fingerprint`]), the sync bookkeeping file
//! ([`sync_state`]), when the cache is rebuilt ([`cache_rebuild`]), the
//! database thread ([`db_actor`]), startup ([`service`]), the lock the
//! resets and deletes hold against the sync passes ([`reset_lock`]), the
//! per-day JSONL masters ([`jsonl`]), the deleted ranges of a device's data
//! ([`deleted_ranges`]), the record-start keymap snapshots
//! ([`keymap_snapshots`]), the replay of a device's day file with its
//! deleted ranges hidden ([`deleted_ranges_cache`]), the query layer the
//! commands read through ([`queries`]) with the aggregates it builds
//! ([`bigram_aggregate`], [`layout_resolver`], [`layout_comparison`]), and
//! the recording: the events ([`event`]), their per-minute aggregation
//! ([`minute_buffer`], [`bigram_bucket`]), the sessions
//! ([`session_detector`]), the rows a flush writes ([`rows`]) and the flush
//! itself ([`pipeline`]).

pub mod bigram_aggregate;
pub mod bigram_bucket;
pub mod cache_rebuild;
pub mod db_actor;
pub mod deleted_ranges;
pub mod deleted_ranges_cache;
pub mod event;
pub mod fingerprint;
pub mod identity;
pub mod jsonl;
pub mod keymap_snapshots;
pub mod layout_comparison;
pub mod layout_resolver;
pub mod minute_buffer;
pub mod pipeline;
pub mod queries;
pub mod reset_lock;
pub mod rows;
pub mod service;
pub mod session_detector;
pub mod sync_state;
pub mod sync_units;

pub use cache_rebuild::{Freshness, ensure_cache_is_fresh};
pub use db_actor::DbActor;
pub use deleted_ranges_cache::replay_day_hiding_deleted_ranges;
pub use identity::{IdentityError, MachineIdentity};
pub use pipeline::{FlushTimer, Recorder, RecorderDeps};
pub use reset_lock::{Busy, ResetKeyboards, SyncRuntime};
pub use service::{Ready, RebuildCache, TypingAnalytics};
pub use sync_state::TypingSyncState;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Identity(#[from] IdentityError),
    #[error(transparent)]
    Db(#[from] pipette_typing_analytics_db::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("the typing-analytics database thread has stopped")]
    DbThreadGone,
    #[error("cache rebuild: {0}")]
    CacheRebuild(String),
    #[error("the typing-analytics initialization stopped before it finished")]
    InitializationLost,
    #[error("a blocking task did not finish: {0}")]
    Blocking(String),
    #[error(transparent)]
    LayoutEntry(#[from] layout_resolver::BadLayoutEntry),
}
