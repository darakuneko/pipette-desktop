// SPDX-License-Identifier: GPL-2.0-or-later
//! What the upload side and the resets do to the pending units: a pass takes the generations
//! before it uploads and settles each unit it sent only while its
//! generation is still that one; a reset cancels the units of what it
//! removes, writing first, and can put them back.

use indexmap::{IndexMap, IndexSet};
use pipette_js_json::JsString;

use crate::{PendingStore, file, lock};

/// Why a cancel did not happen; the pending state is as it was.
#[derive(Debug, thiserror::Error)]
pub enum PendingWriteError {
    /// The file existed at startup but could not be read, so a cancel that
    /// must be on disk cannot be: a unit cancelled only in memory would
    /// come back from the file once it can be read again.
    #[error("The pending sync changes file cannot be read; restart Pipette and try again")]
    Unreadable,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// A copy of the pending units for [`PendingStore::restore_cancelled`]
/// (`PendingStateCopy`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PendingStateCopy {
    generations: IndexMap<JsString, u64>,
    held: IndexMap<JsString, IndexSet<JsString>>,
}

impl PendingStateCopy {
    /// The generation `unit` had when the copy was taken.
    pub fn generation_of(&self, unit: &str) -> Option<u64> {
        self.generations.get(unit).copied()
    }
}

/// `unit.startsWith(prefix)`, in UTF-16 code units for a unit with a lone
/// surrogate.
fn starts_with(unit: &JsString, prefix: &str) -> bool {
    match unit.as_str() {
        Some(text) => text.starts_with(prefix),
        None => unit.utf16_units().starts_with(&prefix.encode_utf16().collect::<Vec<_>>()),
    }
}

impl PendingStore {
    /// The generation of every pending unit, in the order they were first
    /// marked; taken before a pass uploads them.
    pub fn snapshot_generations(&self) -> IndexMap<JsString, u64> {
        lock(&self.shared.state).units.clone()
    }

    /// Removes an uploaded unit unless it was marked again after `generation`
    /// was taken (its generation is no longer exactly that one), and
    /// schedules the write. The listener is not told; the pass tells it once
    /// after its settles ([`Self::broadcast_status`]).
    pub fn settle(&self, unit: &str, generation: u64) {
        let ticket = {
            let mut state = lock(&self.shared.state);
            if state.units.get(unit).copied().unwrap_or(0) != generation {
                return;
            }
            state.units.shift_remove(unit);
            if self.shared.persist { state.reserve_write() } else { None }
        };
        self.schedule_write(ticket);
    }

    /// Drops the units starting with any of `prefixes` (every unit for `None`,
    /// none for an empty list), held units of other accounts included. The
    /// resulting state is written before memory changes, so a crash right after
    /// cannot bring a cancelled unit back at the next launch; a failed write
    /// leaves the pending state as it was. Nothing is written when nothing
    /// matches, unless `write_always` asks for the write anyway (a reset's
    /// first cancel finds a disk failure before it removes anything); with it,
    /// a file that could not be read at startup is refused.
    pub fn cancel(&self, prefixes: Option<&[&str]>, write_always: bool) -> Result<(), PendingWriteError> {
        let cancels = |unit: &JsString| prefixes.is_none_or(|list| list.iter().any(|p| starts_with(unit, p)));
        if write_always && !self.shared.persist {
            return Err(PendingWriteError::Unreadable);
        }
        let cancelled = self.with_write_lock(|state| {
            let matches_held = state.held.values().any(|units| units.iter().any(cancels));
            if !write_always && !matches_held && !state.units.keys().any(cancels) {
                return Ok(false);
            }
            let held: IndexMap<JsString, IndexSet<JsString>> = state
                .held
                .iter()
                .filter(|(sub, _)| sub.as_str() != Some("__proto__"))
                .filter_map(|(sub, units)| {
                    let kept: IndexSet<JsString> =
                        units.iter().filter(|unit| !cancels(unit)).cloned().collect();
                    (!kept.is_empty()).then(|| (sub.clone(), kept))
                })
                .collect();
            let content =
                file::content(state.owner.as_ref(), state.units.keys().filter(|u| !cancels(u)), &held);
            self.write_locked(state, &content)?;
            state.units.retain(|unit, _| !cancels(unit));
            state.held = held;
            Ok::<_, std::io::Error>(true)
        })?;
        if cancelled {
            self.broadcast_status();
        }
        Ok(())
    }

    /// The units and their generations, and the held units, for
    /// [`Self::restore_cancelled`].
    pub fn copy_state(&self) -> PendingStateCopy {
        let state = lock(&self.shared.state);
        PendingStateCopy { generations: state.units.clone(), held: state.held.clone() }
    }

    /// Puts back the units of `copy` that are gone now (what a cancel
    /// removed) and writes the result. An active unit gets its copied
    /// generation unless it was marked again meanwhile (its newer generation
    /// stays); a held unit joins its account's held set. Nothing added since
    /// the copy is removed, and the owner is left alone (a cancel does not
    /// change it). A failed write is logged and left to the next write.
    pub fn restore_cancelled(&self, copy: &PendingStateCopy) {
        {
            let mut state = lock(&self.shared.state);
            for (unit, generation) in &copy.generations {
                state.units.entry(unit.clone()).or_insert(*generation);
            }
            for (sub, units) in &copy.held {
                state.held.entry(sub.clone()).or_default().extend(units.iter().cloned());
            }
            state.held.retain(|_, units| !units.is_empty());
        }
        self.commit_state();
    }
}
