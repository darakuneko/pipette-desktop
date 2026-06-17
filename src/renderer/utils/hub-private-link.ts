// SPDX-License-Identifier: GPL-2.0-or-later

import type { HubPrivateUploadResult } from '../../shared/types/hub'
import type { HubPrivateLink } from '../../shared/types/hub-private'

/** Builds the persistable {@link HubPrivateLink} from a successful private
 *  upload result. Callers must have already checked `result.success`. */
export function linkFromResult(result: HubPrivateUploadResult): HubPrivateLink {
  return { id: result.id!, url: result.url!, expiresAt: result.expiresAt ?? null }
}
