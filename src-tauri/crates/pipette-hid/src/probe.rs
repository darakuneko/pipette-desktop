// SPDX-License-Identifier: GPL-2.0-or-later
//! The probe handle: a second, temporary handle on a keyboard other than the
//! main connection, over which the WebView runs the probe sequence
//! (src/shared/hid/probe-sequence.ts) for the layout picker. At most one is
//! open; each open gets a new id, so a request with the id of a handle that
//! has since been replaced or closed fails instead of reaching another
//! keyboard.

use std::ffi::CString;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::backend::HidHandle;

struct ProbeDevice {
    id: u32,
    handle: Arc<dyn HidHandle>,
    path: CString,
}

#[derive(Default)]
pub(crate) struct ProbeSlot {
    inner: Mutex<SlotState>,
}

#[derive(Default)]
struct SlotState {
    current: Option<ProbeDevice>,
    last_id: u32,
    /// Advanced by [`ProbeSlot::supersede`]; a probe opened across a change
    /// is not registered.
    epoch: u64,
}

impl ProbeSlot {
    fn lock(&self) -> MutexGuard<'_, SlotState> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The epoch to pass to [`ProbeSlot::replace`], taken before opening.
    pub(crate) fn epoch(&self) -> u64 {
        self.lock().epoch
    }

    /// Makes `handle` the probe handle, closing the one it replaces, and
    /// returns its id. When the slot has been superseded since `epoch` was
    /// taken, closes `handle` instead and returns `None`.
    pub(crate) fn replace(&self, handle: Arc<dyn HidHandle>, path: CString, epoch: u64) -> Option<u32> {
        let (id, to_close) = {
            let mut state = self.lock();
            if state.epoch != epoch {
                (None, Some(handle))
            } else {
                state.last_id = state.last_id.wrapping_add(1);
                let id = state.last_id;
                (Some(id), state.current.replace(ProbeDevice { id, handle, path }).map(|d| d.handle))
            }
        };
        if let Some(handle) = to_close {
            handle.close();
        }
        id
    }

    /// Closes the probe handle and refuses every probe being opened now.
    pub(crate) fn supersede(&self) {
        let closed = {
            let mut state = self.lock();
            state.epoch = state.epoch.wrapping_add(1);
            state.current.take()
        };
        if let Some(device) = closed {
            device.handle.close();
        }
    }

    /// The handle with this id, while it is the open one.
    pub(crate) fn handle(&self, id: u32) -> Option<Arc<dyn HidHandle>> {
        self.lock().current.as_ref().filter(|d| d.id == id).map(|d| Arc::clone(&d.handle))
    }

    /// Closes the probe handle when `id` is `None` or its id.
    pub(crate) fn close(&self, id: Option<u32>) {
        self.close_if(|d| id.is_none_or(|id| d.id == id));
    }

    /// Closes the probe handle when it is open on `path`.
    pub(crate) fn close_path(&self, path: &CString) {
        self.close_if(|d| d.path == *path);
    }

    fn close_if(&self, matches: impl FnOnce(&ProbeDevice) -> bool) {
        let closed = {
            let mut state = self.lock();
            if state.current.as_ref().is_some_and(matches) { state.current.take() } else { None }
        };
        if let Some(device) = closed {
            device.handle.close();
        }
    }
}
