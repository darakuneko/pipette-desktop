// SPDX-License-Identifier: GPL-2.0-or-later
// The language-pack, theme-pack and key-label routes of the fake Hub, in
// the order of the Hub worker's routes/i18n-packs.ts, routes/theme-packs.ts
// and routes/key-labels.ts: list, detail, download, timestamps and the
// authenticated create / update / delete, with the Hub's checks and texts.

import {
  authenticate,
  fail,
  isAnswer,
  isFile,
  ok,
  pageOf,
  pagination,
  readForm,
  readJsonBody,
  type HubAnswer,
  type HubRequest,
} from './hub-http'
import type { Route } from './hub-routes'
import { SYSTEM_USER_ID, byUpdatedDesc, type HubKeyLabel, type HubPack, type HubState, type HubUser, type PackKind } from './hub-state'
import { I18N_MAX_BYTES, THEME_MAX_BYTES, parseI18nExport, parseThemePack, validateKeyLabelPayload } from './hub-validate'

const TIMESTAMPS_MAX_IDS = 100
const TIMESTAMPS_MAX_BODY_BYTES = 16 * 1024
const TIMESTAMPS_MAX_ID_LENGTH = 64
const KEY_LABEL_MAX_BODY_BYTES = 64 * 1024
const QUERY_MAX_LENGTH = 200

const PACK_LABEL: Record<PackKind, string> = { i18n: 'i18n pack', theme: 'theme pack' }
const PACK_FILE_PREFIX: Record<PackKind, string> = { i18n: 'i18n-pack', theme: 'theme-pack' }

function containsIgnoringCase(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase())
}

function downloadFilename(prefix: string, name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
  return `${cleaned.length > 0 ? `${prefix}-${cleaned}` : prefix}.json`
}

/** A download: the JSON pretty-printed with two spaces, not wrapped. */
function download(value: unknown, filename: string): HubAnswer {
  return {
    status: 200,
    body: JSON.stringify(value, null, 2),
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'public, max-age=3600',
    },
  }
}

/** `{ids}` (up to 100 strings of up to 64 characters) to `{items}`: the
 *  `{id, updated_at}` of each id that exists, once, in the order asked. */
function timestamps(req: HubRequest, records: Array<{ id: string; updated_at: string }>): HubAnswer {
  if (req.body.length > TIMESTAMPS_MAX_BODY_BYTES) return fail(413, 'Request body too large')
  const parsed = readJsonBody(req)
  if (isAnswer(parsed)) return parsed
  const ids = (parsed as { ids?: unknown } | null)?.ids
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(ids)) return fail(400, 'ids must be an array')
  if (ids.length > TIMESTAMPS_MAX_IDS) return fail(400, `Too many ids (max ${TIMESTAMPS_MAX_IDS})`)
  if (!ids.every((id) => typeof id === 'string' && id.length <= TIMESTAMPS_MAX_ID_LENGTH)) {
    return fail(400, `ids must be strings (max ${TIMESTAMPS_MAX_ID_LENGTH} chars)`)
  }
  const items = [...new Set(ids as string[])].flatMap((id) => {
    const record = records.find((candidate) => candidate.id === id)
    return record ? [{ id: record.id, updated_at: record.updated_at }] : []
  })
  return ok({ items })
}

/** The record `id` of the request's account, or the Hub's refusal. */
function owned<T extends { id: string; uploaded_by: string | null }>(records: T[], id: string, user: HubUser, notFound: string): T | HubAnswer {
  const record = records.find((candidate) => candidate.id === id)
  if (!record) return fail(404, notFound)
  if (record.uploaded_by !== user.id) return fail(403, 'Forbidden')
  return record
}

// --- /api/i18n-packs and /api/theme-packs ----------------------------------------

/** The `json` file of a pack upload: its name, version and text. */
function packUpload(kind: PackKind, req: HubRequest): { name: string; version: string; packJson: string } | HubAnswer {
  const json = readForm(req).json
  const maxBytes = kind === 'i18n' ? I18N_MAX_BYTES : THEME_MAX_BYTES
  if (!isFile(json)) return fail(400, 'JSON file is required')
  if (json.bytes.length > maxBytes) return fail(400, `JSON file exceeds ${maxBytes} bytes`)
  if (!json.filename.toLowerCase().endsWith('.json')) return fail(400, 'JSON file must have .json extension')
  const text = json.bytes.toString('utf8')
  const parsed = kind === 'i18n' ? parseI18nExport(text) : parseThemePack(text)
  if (!parsed.ok) return fail(400, parsed.error)
  return { ...parsed.value, packJson: text }
}

function nameVersionTaken(packs: HubPack[], name: string, version: string, exceptId?: string): boolean {
  return packs.some((pack) => pack.id !== exceptId && pack.name.toLowerCase() === name.toLowerCase() && pack.version === version)
}

function packRoutes(kind: PackKind): Route[] {
  const base = kind === 'i18n' ? 'i18n-packs' : 'theme-packs'
  const notFound = `${PACK_LABEL[kind]} not found`
  const packs = (state: HubState): HubPack[] => state.packs[kind]
  const byId = (state: HubState, id: string): HubPack | undefined => packs(state).find((pack) => pack.id === id)
  const one = new RegExp(`^/api/${base}/([^/]+)$`)

  const list = (state: HubState, req: HubRequest): HubAnswer => {
    const { page, perPage } = pagination(req)
    const query = (req.query.get('q') ?? '').slice(0, QUERY_MAX_LENGTH).trim()
    const name = (req.query.get('name') ?? '').slice(0, QUERY_MAX_LENGTH).trim()
    const matching = byUpdatedDesc(
      packs(state).filter((pack) => (!query || containsIgnoringCase(pack.name, query)) && (!name || pack.name.toLowerCase() === name.toLowerCase())),
    )
    const items = pageOf(matching, page, perPage).map((pack) => state.packSummary(kind, pack))
    return ok({ items, total: matching.length, page, per_page: perPage })
  }

  const create = (state: HubState, req: HubRequest): HubAnswer => {
    const user = authenticate(state, req)
    if (isAnswer(user)) return user
    if (!user.display_name) return fail(400, 'Display name is required to upload')
    const upload = packUpload(kind, req)
    if (isAnswer(upload)) return upload
    if (nameVersionTaken(packs(state), upload.name, upload.version)) return fail(409, 'name and version already exist')
    const now = state.stamp()
    const pack: HubPack = { id: state.newId(), name: upload.name, version: upload.version, pack_json: upload.packJson, uploaded_by: user.id, created_at: now, updated_at: now }
    packs(state).push(pack)
    return ok(state.packDetail(kind, pack), 201)
  }

  const update = (state: HubState, req: HubRequest, [id]: string[]): HubAnswer => {
    const user = authenticate(state, req)
    if (isAnswer(user)) return user
    const pack = owned(packs(state), id, user, notFound)
    if (isAnswer(pack)) return pack
    const upload = packUpload(kind, req)
    if (isAnswer(upload)) return upload
    if (nameVersionTaken(packs(state), upload.name, upload.version, id)) return fail(409, 'name and version already exist')
    Object.assign(pack, { name: upload.name, version: upload.version, pack_json: upload.packJson, updated_at: state.stamp() })
    return ok(state.packDetail(kind, pack))
  }

  const remove = (state: HubState, req: HubRequest, [id]: string[]): HubAnswer => {
    const user = authenticate(state, req)
    if (isAnswer(user)) return user
    const pack = owned(packs(state), id, user, notFound)
    if (isAnswer(pack)) return pack
    state.packs[kind] = packs(state).filter((candidate) => candidate !== pack)
    return ok({ id })
  }

  return [
    { op: `${kind}.list`, method: 'GET', pattern: new RegExp(`^/api/${base}/?$`), handler: list },
    {
      op: `${kind}.timestamps`,
      method: 'POST',
      pattern: new RegExp(`^/api/${base}/timestamps$`),
      handler: (state, req) => timestamps(req, packs(state)),
    },
    {
      op: `${kind}.get`,
      method: 'GET',
      pattern: one,
      handler: (state, _req, [id]) => {
        const pack = byId(state, id)
        return pack ? ok(state.packDetail(kind, pack)) : fail(404, notFound)
      },
    },
    {
      op: `${kind}.download`,
      method: 'GET',
      pattern: new RegExp(`^/api/${base}/([^/]+)/download$`),
      handler: (state, _req, [id]) => {
        const pack = byId(state, id)
        return pack ? download(JSON.parse(pack.pack_json), downloadFilename(PACK_FILE_PREFIX[kind], pack.name)) : fail(404, notFound)
      },
    },
    { op: `${kind}.create`, method: 'POST', pattern: new RegExp(`^/api/${base}/?$`), handler: create },
    { op: `${kind}.update`, method: 'PUT', pattern: one, handler: update },
    { op: `${kind}.delete`, method: 'DELETE', pattern: one, handler: remove },
  ]
}

// --- /api/key-labels -------------------------------------------------------------

const KEY_LABEL_NOT_FOUND = 'Key label not found'

function keyLabelById(state: HubState, id: string): HubKeyLabel | undefined {
  return state.keyLabels.find((label) => label.id === id)
}

function keyLabelNameTaken(state: HubState, name: string, exceptId?: string): boolean {
  return state.keyLabels.some((label) => label.id !== exceptId && label.name.toLowerCase() === name.toLowerCase())
}

function listKeyLabels(state: HubState, req: HubRequest): HubAnswer {
  const { page, perPage } = pagination(req)
  const query = (req.query.get('q') ?? '').slice(0, QUERY_MAX_LENGTH).trim()
  const matching = byUpdatedDesc(state.keyLabels.filter((label) => !query || containsIgnoringCase(label.name, query)))
  const items = pageOf(matching, page, perPage).map((label) => state.publicKeyLabel(label))
  return ok({ items, total: matching.length, page, per_page: perPage })
}

function createKeyLabel(state: HubState, req: HubRequest): HubAnswer {
  if (req.body.length > KEY_LABEL_MAX_BODY_BYTES) return fail(413, 'Request body too large')
  const user = authenticate(state, req)
  if (isAnswer(user)) return user
  if (!user.display_name) return fail(400, 'Display name is required to upload')
  const parsed = readJsonBody(req)
  if (isAnswer(parsed)) return parsed
  const valid = validateKeyLabelPayload(parsed)
  if (!valid.ok) return fail(400, valid.error)
  if (keyLabelNameTaken(state, valid.value.name)) return fail(409, 'name is already taken')
  const now = state.stamp()
  const label: HubKeyLabel = {
    id: state.newId(),
    name: valid.value.name,
    map: valid.value.map,
    composite_labels: valid.value.compositeLabels,
    keymap_applicable: valid.value.keymapApplicable ?? false,
    uploaded_by: user.id,
    created_at: now,
    updated_at: now,
  }
  state.keyLabels.push(label)
  return ok(state.publicKeyLabel(label), 201)
}

/** The key label `id` of the request's account; the Hub's built-in ones
 *  are refused with `systemError`. */
function ownKeyLabel(state: HubState, user: HubUser, id: string, systemError: string): HubKeyLabel | HubAnswer {
  const label = keyLabelById(state, id)
  if (!label) return fail(404, KEY_LABEL_NOT_FOUND)
  if (label.uploaded_by === SYSTEM_USER_ID) return fail(403, systemError)
  if (label.uploaded_by !== user.id) return fail(403, 'Forbidden')
  return label
}

function updateKeyLabel(state: HubState, req: HubRequest, [id]: string[]): HubAnswer {
  if (req.body.length > KEY_LABEL_MAX_BODY_BYTES) return fail(413, 'Request body too large')
  const user = authenticate(state, req)
  if (isAnswer(user)) return user
  const label = ownKeyLabel(state, user, id, 'System-seeded key labels cannot be modified')
  if (isAnswer(label)) return label
  const parsed = readJsonBody(req)
  if (isAnswer(parsed)) return parsed
  const valid = validateKeyLabelPayload(parsed)
  if (!valid.ok) return fail(400, valid.error)
  if (keyLabelNameTaken(state, valid.value.name, id)) return fail(409, 'name is already taken')
  Object.assign(label, {
    name: valid.value.name,
    map: valid.value.map,
    composite_labels: valid.value.compositeLabels,
    // Absent keeps the stored flag.
    keymap_applicable: valid.value.keymapApplicable ?? label.keymap_applicable,
    updated_at: state.stamp(),
  })
  return ok(state.publicKeyLabel(label))
}

function deleteKeyLabel(state: HubState, req: HubRequest, [id]: string[]): HubAnswer {
  const user = authenticate(state, req)
  if (isAnswer(user)) return user
  const label = ownKeyLabel(state, user, id, 'System-seeded key labels cannot be deleted')
  if (isAnswer(label)) return label
  state.keyLabels = state.keyLabels.filter((candidate) => candidate !== label)
  return ok({ id })
}

const KEY_LABEL_ONE = /^\/api\/key-labels\/([^/]+)$/

export const PACK_AND_KEY_LABEL_ROUTES: Route[] = [
  ...packRoutes('i18n'),
  ...packRoutes('theme'),
  { op: 'keyLabels.list', method: 'GET', pattern: /^\/api\/key-labels\/?$/, handler: listKeyLabels },
  { op: 'keyLabels.timestamps', method: 'POST', pattern: /^\/api\/key-labels\/timestamps$/, handler: (state, req) => timestamps(req, state.keyLabels) },
  {
    op: 'keyLabels.get',
    method: 'GET',
    pattern: KEY_LABEL_ONE,
    handler: (state, _req, [id]) => {
      const label = keyLabelById(state, id)
      return label ? ok(state.publicKeyLabel(label)) : fail(404, KEY_LABEL_NOT_FOUND)
    },
  },
  {
    op: 'keyLabels.download',
    method: 'GET',
    pattern: /^\/api\/key-labels\/([^/]+)\/download$/,
    handler: (state, _req, [id]) => {
      const label = keyLabelById(state, id)
      if (!label) return fail(404, KEY_LABEL_NOT_FOUND)
      const body = { name: label.name, map: label.map, composite_labels: label.composite_labels, keymap_applicable: label.keymap_applicable }
      return download(body, downloadFilename('key-labels', label.name))
    },
  },
  { op: 'keyLabels.create', method: 'POST', pattern: /^\/api\/key-labels\/?$/, handler: createKeyLabel },
  { op: 'keyLabels.update', method: 'PUT', pattern: KEY_LABEL_ONE, handler: updateKeyLabel },
  { op: 'keyLabels.delete', method: 'DELETE', pattern: KEY_LABEL_ONE, handler: deleteKeyLabel },
]
