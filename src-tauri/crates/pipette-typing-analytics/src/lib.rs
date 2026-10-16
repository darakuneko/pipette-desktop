// SPDX-License-Identifier: GPL-2.0-or-later
//! The typing analytics of the Electron build's src/main/typing-analytics/
//! above the SQLite layer (`pipette-typing-analytics-db`): who recorded
//! the data ([`identity`]), the sync bookkeeping file ([`sync_state`]),
//! when the cache is rebuilt ([`cache_rebuild`]), the database thread
//! ([`db_actor`]), startup ([`service`]) and the lock the resets and
//! deletes hold against the sync passes ([`reset_lock`]).

pub mod cache_rebuild;
pub mod db_actor;
pub mod identity;
pub mod reset_lock;
pub mod service;
pub mod sync_state;

pub use cache_rebuild::{Freshness, ensure_cache_is_fresh};
pub use db_actor::DbActor;
pub use identity::{IdentityError, MachineIdentity};
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
}
