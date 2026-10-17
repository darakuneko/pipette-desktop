// SPDX-License-Identifier: GPL-2.0-or-later
// The account, post and private-post routes of the fake Hub, in the order
// of the Hub worker's routes/auth.ts, routes/files.ts and
// routes/private/files.ts: the same checks in the same order with the same
// error texts. The Hub's daily upload / update limits and its rate limits
// are left out; a 429 comes only from an injected fault.

import {
  authenticate,
  fail,
  isAnswer,
  isFile,
  ok,
  pageOf,
  pagination,
  readForm,
  readJsonObject,
  stringOrNull,
  type FormFile,
  type FormValue,
  type HubAnswer,
  type HubRequest,
} from './hub-http'
import type { HubOp, HubPost, HubState, HubUser } from './hub-state'
import {
  featureJsonError,
  isReservedDisplayName,
  normalizeDisplayName,
  parseAnalyticsExport,
  parseExpiresInDays,
  parseTestIdToken,
  parseUnverifiedJwt,
} from './hub-validate'

export type RouteHandler = (state: HubState, req: HubRequest, params: string[]) => HubAnswer

export interface Route {
  op: HubOp
  method: string
  pattern: RegExp
  handler: RouteHandler
}

const MAX_TITLE_LENGTH = 200
const MAX_KEYBOARD_NAME_LENGTH = 100
const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_THUMBNAIL_SIZE = 2 * 1024 * 1024
const MAX_USER_KEYBOARD_POSTS = 30
const KEYBOARD_FILE_TYPES = ['vil', 'c', 'pdf', 'pipette'] as const
const FEATURE_POST_TYPES = ['td', 'macro', 'combo', 'ko', 'ark']

function userResponse(user: HubUser): Record<string, unknown> {
  return { id: user.id, email: user.email, display_name: user.display_name, role: user.role }
}

// --- /api/auth -----------------------------------------------------------------

function token(state: HubState, req: HubRequest): HubAnswer {
  const body = readJsonObject(req)
  if (isAnswer(body)) return body
  if (!body.id_token || typeof body.id_token !== 'string') return fail(400, 'Missing id_token')
  const override = body.display_name
  if (override !== undefined && override !== null && typeof override !== 'string') return fail(400, 'display_name must be a string or null')
  const identity = parseTestIdToken(body.id_token) ?? parseUnverifiedJwt(body.id_token)
  if (!identity) return fail(401, 'Invalid or expired token')
  if (override !== undefined && normalizeDisplayName(override) == null) return fail(400, 'display_name must not be empty')
  const name = normalizeDisplayName(override !== undefined ? override : identity.name)
  if (name != null) {
    if (isReservedDisplayName(name)) return fail(400, 'display_name is reserved')
    if (state.displayNameTaken(name, state.userByEmail(identity.email)?.id)) return fail(409, 'display_name is already taken')
  }
  // An existing account keeps its display name; only a new one takes it.
  const user = state.userByEmail(identity.email) ?? state.createUser(identity.email, name)
  if (!user.is_active) return fail(403, 'Account is deactivated')
  return ok({ token: state.issueJwt(user), user: userResponse(user) })
}

function getMe(state: HubState, req: HubRequest): HubAnswer {
  const user = authenticate(state, req)
  return isAnswer(user) ? user : ok(userResponse(user))
}

function patchMe(state: HubState, req: HubRequest): HubAnswer {
  const user = authenticate(state, req)
  if (isAnswer(user)) return user
  const body = readJsonObject(req)
  if (isAnswer(body)) return body
  if (Object.keys(body).some((key) => key !== 'display_name')) return fail(400, 'Unknown field in request body')
  if (!('display_name' in body)) return fail(400, 'No fields to update')
  const raw = body.display_name
  if (raw !== null && typeof raw !== 'string') return fail(400, 'display_name must be a string or null')
  const name = normalizeDisplayName(raw)
  if (name == null) return fail(400, 'display_name must not be empty')
  if (isReservedDisplayName(name)) return fail(400, 'display_name is reserved')
  if (state.displayNameTaken(name, user.id)) return fail(409, 'display_name is already taken')
  user.display_name = name
  return ok(userResponse(user))
}

// --- Uploads -------------------------------------------------------------------

type PostContent = Pick<HubPost, 'title' | 'keyboard_name' | 'post_type' | 'files' | 'keyboard_uid' | 'total_keystrokes' | 'range_from_ms' | 'range_to_ms'>

function titleOf(form: Record<string, FormValue>): string | HubAnswer {
  const title = stringOrNull(form.title)
  if (!title) return fail(400, 'Title is required')
  if (title.length > MAX_TITLE_LENGTH) return fail(400, `Title must be ${MAX_TITLE_LENGTH} characters or less`)
  return title
}

function thumbnailOf(form: Record<string, FormValue>): FormFile | HubAnswer {
  const thumbnail = form.thumbnail
  if (!isFile(thumbnail)) return fail(400, 'Thumbnail (.jpg) is required')
  if (!/\.jpe?g$/i.test(thumbnail.filename)) return fail(400, 'Thumbnail must be a .jpg file')
  if (thumbnail.bytes.length > MAX_THUMBNAIL_SIZE) return fail(400, 'Thumbnail exceeds 2MB')
  return thumbnail
}

function jsonFileOf(form: Record<string, FormValue>): FormFile | HubAnswer {
  const json = form.json
  if (!isFile(json)) return fail(400, 'JSON file is required')
  if (json.bytes.length > MAX_FILE_SIZE) return fail(400, 'JSON file exceeds 10MB')
  if (!json.filename.toLowerCase().endsWith('.json')) return fail(400, 'JSON file must have .json extension')
  return json
}

function fileEntry(fileType: string, file: FormFile): HubPost['files'][number] {
  return { file_type: fileType, original_filename: file.filename, file_size: file.bytes.length }
}

const NO_ANALYTICS = { keyboard_uid: null, total_keystrokes: null, range_from_ms: null, range_to_ms: null }

/** What an upload of `postType` holds: an analytics post (title, thumbnail,
 *  analytics export), a feature post (title, post type, favorite JSON) or
 *  a keyboard post (title, thumbnail, vil, c, pdf, pipette). */
function postContent(form: Record<string, FormValue>, postType: unknown, keyboardName: string | null): PostContent | HubAnswer {
  const title = titleOf(form)
  if (isAnswer(title)) return title
  if (postType === 'analytics') {
    const thumbnail = thumbnailOf(form)
    if (isAnswer(thumbnail)) return thumbnail
    const json = jsonFileOf(form)
    if (isAnswer(json)) return json
    const parsed = parseAnalyticsExport(json.bytes.toString('utf8'))
    if (!parsed.ok) return fail(400, parsed.error)
    return {
      title,
      // The keyboard name of an analytics post comes from its export.
      keyboard_name: parsed.value.productName,
      post_type: 'analytics',
      files: [fileEntry('json', json)],
      keyboard_uid: parsed.value.keyboardUid,
      total_keystrokes: parsed.value.totalKeystrokes,
      range_from_ms: parsed.value.rangeFromMs,
      range_to_ms: parsed.value.rangeToMs,
    }
  }
  if (typeof postType === 'string' && FEATURE_POST_TYPES.includes(postType)) {
    const json = jsonFileOf(form)
    if (isAnswer(json)) return json
    const contentError = featureJsonError(json.bytes)
    if (contentError) return fail(400, contentError)
    return { title, keyboard_name: keyboardName, post_type: postType, files: [fileEntry('json', json)], ...NO_ANALYTICS }
  }
  const thumbnail = thumbnailOf(form)
  if (isAnswer(thumbnail)) return thumbnail
  const files: HubPost['files'] = []
  for (const fileType of KEYBOARD_FILE_TYPES) {
    const file = form[fileType]
    if (!isFile(file)) return fail(400, `File "${fileType}" is required`)
    if (file.bytes.length > MAX_FILE_SIZE) return fail(400, `File "${fileType}" exceeds 10MB`)
    if (!file.filename.toLowerCase().endsWith(`.${fileType}`)) return fail(400, `File "${fileType}" must have .${fileType} extension`)
    files.push(fileEntry(fileType, file))
  }
  return { title, keyboard_name: keyboardName, post_type: 'keyboard', files, ...NO_ANALYTICS }
}

/** The request's account, which must have a display name to upload. */
function uploader(state: HubState, req: HubRequest): HubUser | HubAnswer {
  const user = authenticate(state, req)
  if (isAnswer(user)) return user
  return user.display_name ? user : fail(400, 'Display name is required to upload')
}

/** The form of an upload with its keyboard name, or the Hub's refusal of
 *  a keyboard name that is too long. */
function uploadForm(req: HubRequest): { form: Record<string, FormValue>; keyboardName: string | null } | HubAnswer {
  const form = readForm(req)
  const keyboardName = stringOrNull(form.keyboard_name)
  if (keyboardName && keyboardName.length > MAX_KEYBOARD_NAME_LENGTH) {
    return fail(400, `Keyboard name must be ${MAX_KEYBOARD_NAME_LENGTH} characters or less`)
  }
  return { form, keyboardName }
}

/** A post of another account's or of a deactivated account is not found,
 *  as the Hub joins on active accounts. */
function activePost(state: HubState, id: string): HubPost | undefined {
  const post = state.posts.find((candidate) => candidate.id === id)
  return post && state.userById(post.uploaded_by)?.is_active ? post : undefined
}

// --- /api/files ----------------------------------------------------------------

function myPosts(state: HubState, req: HubRequest): HubAnswer {
  const user = authenticate(state, req)
  if (isAnswer(user)) return user
  const { page, perPage } = pagination(req)
  const posts = state.postsOf(user.id)
  return ok({ items: pageOf(posts, page, perPage).map((post) => state.publicPost(post)), total: posts.length, page, per_page: perPage })
}

function myKeyboardPosts(state: HubState, req: HubRequest): HubAnswer {
  const user = authenticate(state, req)
  if (isAnswer(user)) return user
  const name = req.query.get('name')?.trim()
  if (!name) return fail(400, 'Query parameter "name" is required')
  if (name.length > MAX_KEYBOARD_NAME_LENGTH) return fail(400, `Keyboard name must be ${MAX_KEYBOARD_NAME_LENGTH} characters or less`)
  const posts = state.postsOf(user.id).filter((post) => post.keyboard_name === name).slice(0, MAX_USER_KEYBOARD_POSTS)
  return ok(posts.map((post) => state.publicPost(post)))
}

function getPost(state: HubState, _req: HubRequest, [id]: string[]): HubAnswer {
  const post = activePost(state, id)
  return post ? ok(state.publicPost(post)) : fail(404, 'Post not found')
}

function createPost(state: HubState, req: HubRequest): HubAnswer {
  const user = uploader(state, req)
  if (isAnswer(user)) return user
  const upload = uploadForm(req)
  if (isAnswer(upload)) return upload
  const content = postContent(upload.form, upload.form.post_type, upload.keyboardName)
  if (isAnswer(content)) return content
  const post = state.newPost({ ...content, uploaded_by: user.id })
  state.posts.push(post)
  return ok(state.publicPost(post), 201)
}

/** The post `id` of the request's account, or the Hub's refusal. */
function ownPost(state: HubState, user: HubUser, id: string): HubPost | HubAnswer {
  const post = activePost(state, id)
  if (!post) return fail(404, 'Post not found')
  if (post.uploaded_by !== user.id) return fail(403, 'Forbidden')
  return post
}

function updatePost(state: HubState, req: HubRequest, [id]: string[]): HubAnswer {
  const user = uploader(state, req)
  if (isAnswer(user)) return user
  const post = ownPost(state, user, id)
  if (isAnswer(post)) return post
  const upload = uploadForm(req)
  if (isAnswer(upload)) return upload
  // The post keeps its type: the form's `post_type` is not read.
  const postType = post.post_type === 'keyboard' ? undefined : post.post_type
  const content = postContent(upload.form, postType, upload.keyboardName)
  if (isAnswer(content)) return content
  Object.assign(post, content, { updated_at: state.stamp() })
  return ok(state.publicPost(post))
}

function patchPost(state: HubState, req: HubRequest, [id]: string[]): HubAnswer {
  const user = authenticate(state, req)
  if (isAnswer(user)) return user
  const post = ownPost(state, user, id)
  if (isAnswer(post)) return post
  const body = readJsonObject(req)
  if (isAnswer(body)) return body
  const fields: { title?: string; keyboard_name?: string | null } = {}
  if ('title' in body) {
    if (typeof body.title !== 'string' || !body.title.trim()) return fail(400, 'Title must be a non-empty string')
    const title = body.title.trim()
    if (title.length > MAX_TITLE_LENGTH) return fail(400, `Title must be ${MAX_TITLE_LENGTH} characters or less`)
    fields.title = title
  }
  if ('keyboard_name' in body) {
    if (body.keyboard_name !== null && typeof body.keyboard_name !== 'string') return fail(400, 'Keyboard name must be a string or null')
    const keyboardName = stringOrNull(body.keyboard_name)
    if (keyboardName && keyboardName.length > MAX_KEYBOARD_NAME_LENGTH) {
      return fail(400, `Keyboard name must be ${MAX_KEYBOARD_NAME_LENGTH} characters or less`)
    }
    fields.keyboard_name = keyboardName
  }
  if (Object.keys(fields).length === 0) return fail(400, 'No fields to update')
  Object.assign(post, fields, { updated_at: state.stamp() })
  return ok(state.publicPost(post))
}

function deletePost(state: HubState, req: HubRequest, [id]: string[]): HubAnswer {
  const user = authenticate(state, req)
  if (isAnswer(user)) return user
  const post = ownPost(state, user, id)
  if (isAnswer(post)) return post
  state.posts = state.posts.filter((candidate) => candidate !== post)
  return ok({ id: post.id })
}

// --- /api/private/files --------------------------------------------------------

function createPrivate(state: HubState, req: HubRequest): HubAnswer {
  const user = uploader(state, req)
  if (isAnswer(user)) return user
  const upload = uploadForm(req)
  if (isAnswer(upload)) return upload
  const days = parseExpiresInDays(upload.form.expires_in_days)
  if (!days.ok) return fail(400, days.error)
  const content = postContent(upload.form, upload.form.post_type, upload.keyboardName)
  if (isAnswer(content)) return content
  const { token: shareToken, expiresAt } = state.privateToken()
  const post = { ...state.newPost({ ...content, uploaded_by: user.id }), token: shareToken, expires_at: expiresAt(days.value) }
  state.privatePosts.push(post)
  return ok({ id: post.id, token: post.token, url: `/private/post/${post.id}?token=${post.token}`, expires_at: post.expires_at }, 201)
}

function deletePrivate(state: HubState, req: HubRequest, [id]: string[]): HubAnswer {
  const user = authenticate(state, req)
  if (isAnswer(user)) return user
  const post = state.privatePosts.find((candidate) => candidate.id === id)
  if (!post) return fail(404, 'Not found')
  if (post.uploaded_by !== user.id) return fail(403, 'Forbidden')
  state.privatePosts = state.privatePosts.filter((candidate) => candidate !== post)
  return ok({ id })
}

/** `/api/files/me` and `/api/files/me/keyboard` come before `/api/files/:id`. */
export const ACCOUNT_AND_POST_ROUTES: Route[] = [
  { op: 'auth.token', method: 'POST', pattern: /^\/api\/auth\/token$/, handler: token },
  { op: 'auth.me', method: 'GET', pattern: /^\/api\/auth\/me$/, handler: getMe },
  { op: 'auth.patchMe', method: 'PATCH', pattern: /^\/api\/auth\/me$/, handler: patchMe },
  { op: 'files.me', method: 'GET', pattern: /^\/api\/files\/me$/, handler: myPosts },
  { op: 'files.meKeyboard', method: 'GET', pattern: /^\/api\/files\/me\/keyboard$/, handler: myKeyboardPosts },
  { op: 'files.get', method: 'GET', pattern: /^\/api\/files\/([^/]+)$/, handler: getPost },
  { op: 'files.create', method: 'POST', pattern: /^\/api\/files\/?$/, handler: createPost },
  { op: 'files.update', method: 'PUT', pattern: /^\/api\/files\/([^/]+)$/, handler: updatePost },
  { op: 'files.patch', method: 'PATCH', pattern: /^\/api\/files\/([^/]+)$/, handler: patchPost },
  { op: 'files.delete', method: 'DELETE', pattern: /^\/api\/files\/([^/]+)$/, handler: deletePost },
  { op: 'private.create', method: 'POST', pattern: /^\/api\/private\/files\/?$/, handler: createPrivate },
  { op: 'private.delete', method: 'DELETE', pattern: /^\/api\/private\/files\/([^/]+)$/, handler: deletePrivate },
]
