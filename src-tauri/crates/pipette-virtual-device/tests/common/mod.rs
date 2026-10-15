// SPDX-License-Identifier: GPL-2.0-or-later
// Helpers shared by the handler tests.

use pipette_virtual_device::protocol::{Report, pad_report};

/// A request report: `bytes` zero-padded to 32 bytes.
pub fn req(bytes: &[u8]) -> Report {
    pad_report(bytes)
}
