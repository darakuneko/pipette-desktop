// SPDX-License-Identifier: GPL-2.0-or-later
//! The Analyze post's export, its preparation and its checks, and the
//! Analyze post handlers.
//!
//! The handlers ([`AnalyticsPosts`]) prepare the export, send it with its
//! thumbnail and link the public post to its saved filter.
//!
//! The export takes this device's machine hash and the time as inputs, so
//! the same cache gives the same bytes ([`prepare::prepare_analytics_export`]).

pub mod export;
pub mod layout;
mod post;
pub mod prepare;
mod source;
pub mod validate;

pub use export::{AnalyticsExport, DeviceScope, ExportError, ExportInput, build_analytics_export};
pub use layout::{LayoutComparisonInputs, sanitize_finger_overrides};
pub use post::AnalyticsPosts;
pub use prepare::{PrepareError, Prepared, prepare_analytics_export, preview};
pub use source::TypingAnalyticsSource;
pub use validate::{
    ANALYTICS_MAX_RANGE_MS, ANALYTICS_MIN_KEYSTROKES, Validation, estimate_analytics_export_size_bytes,
    validate_analytics_export,
};
