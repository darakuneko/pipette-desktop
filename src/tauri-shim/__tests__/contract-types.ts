// SPDX-License-Identifier: GPL-2.0-or-later
// The type contract between the Rust backend and the renderer: each type in
// ../generated is written by the ts-rs export tests of src-tauri
// (`cargo test`) from a type that crosses the IPC boundary, and must be
// mutually assignable with the TypeScript type it stands for. The TypeScript
// types stay the source of truth. Checked by `pnpm typecheck` only; there is
// nothing to run.
//
// Conventions on the Rust side:
// - Field names: `#[serde(rename_all = "camelCase")]` on the struct; ts-rs
//   reads the serde attributes, so the declaration follows.
// - `foo?: T` in TypeScript: `Option<T>` with
//   `#[serde(skip_serializing_if = "Option::is_none")]` and `#[ts(optional)]`.
//   A bare `Option<T>` serializes `None` as null and is declared `foo: T | null`,
//   which fails here against `foo?: T`. IPC is JSON, so `undefined` never
//   arrives as a value.
// - 64-bit integers are declared `bigint` (the ts-rs default), which fails
//   here against `number`: JSON carries them as doubles, so pick a type that
//   fits or override it deliberately.
// - Overrides with `#[ts(type = ...)]` or `#[ts(as = ...)]` hand-write the
//   declaration, so this check does not cover that field. Each one is
//   listed here; there are none.

import type { DecompressDefinition } from '../protocol-members'
import type { PackImportFile } from '../../shared/types/pack-import'
import type { DeviceInfo, DeviceType } from '../../shared/types/protocol'
import type { VialAPI } from '../../shared/types/vial-api'
import type { CompressedDefinition } from '../generated/CompressedDefinition'
import type { CsvBundleResult } from '../generated/CsvBundleResult'
import type { DecompressedDefinition } from '../generated/DecompressedDefinition'
import type { DeviceInfo as GeneratedDeviceInfo } from '../generated/DeviceInfo'
import type { DeviceType as GeneratedDeviceType } from '../generated/DeviceType'
import type { FileOpenResult } from '../generated/FileOpenResult'
import type { FileSaveResult } from '../generated/FileSaveResult'
import type { LanguageActionResult } from '../generated/LanguageActionResult'
import type { TypingDatasetCheckResult } from '../generated/TypingDatasetCheckResult'
import type { PackImportFileRead } from '../generated/PackImportFileRead'
import type { StoredPasswordStatus } from '../generated/StoredPasswordStatus'
import type { SyncAuthStatus } from '../generated/SyncAuthStatus'
import type { UpdateCheckResult } from '../generated/UpdateCheckResult'
import type { UpdateFailure } from '../generated/UpdateFailure'
import type { UpdateInstallResult } from '../generated/UpdateInstallResult'
import type { UpdateProgress } from '../generated/UpdateProgress'
import type { UpdateProgress as SharedUpdateProgress } from '../../shared/types/update'

/** `true` when each type is assignable to the other. The tuples stop the
 *  conditional from distributing over unions. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

type Assert<T extends true> = T

export type ContractChecks = [
  // src-tauri/src/hid_commands.rs
  Assert<MutuallyAssignable<GeneratedDeviceType, DeviceType>>,
  Assert<MutuallyAssignable<GeneratedDeviceInfo, DeviceInfo>>,
  // src-tauri/src/definition.rs
  Assert<MutuallyAssignable<CompressedDefinition, Parameters<DecompressDefinition>[0]>>,
  Assert<MutuallyAssignable<DecompressedDefinition, Awaited<ReturnType<DecompressDefinition>>>>,
  // src-tauri/src/file_commands.rs (sideloadJson's result is FileOpenResult
  // with its text parsed by the shim)
  Assert<MutuallyAssignable<FileSaveResult, Awaited<ReturnType<VialAPI['saveLayout']>>>>,
  Assert<MutuallyAssignable<FileSaveResult, Awaited<ReturnType<VialAPI['exportPdf']>>>>,
  Assert<MutuallyAssignable<FileOpenResult, Awaited<ReturnType<VialAPI['loadLayout']>>>>,
  Assert<MutuallyAssignable<CsvBundleResult, Awaited<ReturnType<VialAPI['exportCsvBundle']>>>>,
  // src-tauri/src/typing_dataset_commands.rs
  Assert<MutuallyAssignable<LanguageActionResult, Awaited<ReturnType<VialAPI['langDownload']>>>>,
  Assert<MutuallyAssignable<LanguageActionResult, Awaited<ReturnType<VialAPI['langDelete']>>>>,
  Assert<MutuallyAssignable<TypingDatasetCheckResult, Awaited<ReturnType<VialAPI['checkTypingDatasetUpdate']>>>>,
  // src-tauri/src/store_commands/pack_import.rs (the shim parses each
  // file's text into the PackImportFile the renderer gets)
  Assert<MutuallyAssignable<PackImportFileRead['filePath'], PackImportFile['filePath']>>,
  Assert<MutuallyAssignable<PackImportFileRead['fileSizeBytes'], PackImportFile['fileSizeBytes']>>,
  // Cloud Sync
  Assert<MutuallyAssignable<SyncAuthStatus, Awaited<ReturnType<VialAPI['syncAuthStatus']>>>>,
  Assert<MutuallyAssignable<StoredPasswordStatus, Awaited<ReturnType<VialAPI['syncPasswordStatus']>>>>,
  // src-tauri/src/updater.rs
  Assert<MutuallyAssignable<UpdateCheckResult, Awaited<ReturnType<VialAPI['updateCheck']>>>>,
  Assert<MutuallyAssignable<UpdateInstallResult, Awaited<ReturnType<VialAPI['updateInstall']>>>>,
  Assert<MutuallyAssignable<UpdateFailure | null, Awaited<ReturnType<VialAPI['updateTakeFailure']>>>>,
  Assert<MutuallyAssignable<UpdateProgress, SharedUpdateProgress>>,
]
