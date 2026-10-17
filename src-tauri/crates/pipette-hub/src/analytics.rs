// SPDX-License-Identifier: GPL-2.0-or-later
//! The Analyze post's export, its preparation and its checks
//! (`src/main/hub/hub-analytics.ts` and `hub-ipc-analytics-prepare.ts`), and
//! the Analyze post handlers of `hub-ipc-analytics.ts`.
//!
//! The export takes this device's machine hash and the time as inputs, so
//! the same cache gives the same bytes ([`prepare::prepare_analytics_export`]).

pub mod export;
pub mod layout;
pub mod prepare;
mod source;
pub mod validate;

pub use export::{AnalyticsExport, DeviceScope, ExportError, ExportInput, build_analytics_export};
pub use layout::{LayoutComparisonInputs, sanitize_finger_overrides};
pub use prepare::{PrepareError, Prepared, prepare_analytics_export, preview};
pub use source::TypingAnalyticsSource;
pub use validate::{
    ANALYTICS_MAX_RANGE_MS, ANALYTICS_MIN_KEYSTROKES, Validation, estimate_analytics_export_size_bytes,
    validate_analytics_export,
};
