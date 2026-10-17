// SPDX-License-Identifier: GPL-2.0-or-later
//! The Hub JWT of `src/main/hub/hub-ipc-token.ts`: its cache in memory only,
//! the one request concurrent callers share, `withTokenRetry` and the
//! sentinels its failures become.
