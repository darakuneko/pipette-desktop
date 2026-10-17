// SPDX-License-Identifier: GPL-2.0-or-later
// Handler scenarios of the Hub account and the JWT (hub-ipc-posts.ts
// auth handlers, hub-ipc-token.ts): the token cache, the display name of
// the first token, the retry after a 401 and the sentinel errors.

import { ok, tokenRule, USER, type Scenario } from '../handler-scenario'

const ME = { method: 'GET', path: '/api/auth/me' }
const PATCH_ME = { method: 'PATCH', path: '/api/auth/me' }
const fetchMe = { call: 'HUB_FETCH_AUTH_ME', args: [] } as const

export const ACCOUNT_SCENARIOS: Scenario[] = [
  {
    name: 'the origin is the Hub base',
    rules: [],
    steps: [{ call: 'HUB_GET_ORIGIN', args: [] }],
  },
  {
    name: 'the first call gets a token, the next ones use the cached one',
    rules: [tokenRule(1), { ...ME, responses: [ok(USER)], repeat: true }, { ...PATCH_ME, responses: [ok({ ...USER, display_name: 'New' })] }],
    steps: [fetchMe, fetchMe, { call: 'HUB_PATCH_AUTH_ME', args: ['  New  '] }],
  },
  {
    name: 'calls made together share one token request',
    rules: [tokenRule(1), { ...ME, responses: [ok(USER)], repeat: true }],
    steps: [{ together: [fetchMe, fetchMe, fetchMe] }],
  },
  {
    name: 'the display name goes with the first token and resets the cache',
    rules: [tokenRule(3), { ...ME, responses: [ok(USER)], repeat: true }],
    steps: [
      { call: 'HUB_SET_AUTH_DISPLAY_NAME', args: ['Alice "A"'] },
      fetchMe,
      fetchMe,
      { call: 'HUB_SET_AUTH_DISPLAY_NAME', args: [null] },
      fetchMe,
      { call: 'HUB_SET_AUTH_DISPLAY_NAME', args: [5] },
      fetchMe,
    ],
  },
  {
    name: 'a token taken while the cache is cleared is not kept',
    rules: [
      tokenRule(1, [{ ...ok({ token: 'stale-jwt', user: USER }), during: 'clearHubTokenCache' }]),
      { ...ME, responses: [ok(USER)], repeat: true },
    ],
    steps: [fetchMe, fetchMe, fetchMe],
  },
  {
    name: 'signing out drops the cached token',
    rules: [tokenRule(2), { ...ME, responses: [ok(USER)], repeat: true }],
    steps: [fetchMe, { clearHubTokenCache: true }, fetchMe],
  },
  {
    name: 'a 401 takes a new token and retries once',
    rules: [tokenRule(2), { ...ME, responses: [{ status: 401, text: 'expired' }, ok(USER)] }],
    steps: [fetchMe],
  },
  {
    name: 'a second 401 is the error and the new token stays cached',
    rules: [tokenRule(2), { ...ME, responses: [{ status: 401, text: 'expired' }, { status: 401, text: 'still' }, ok(USER)] }],
    steps: [fetchMe, fetchMe],
  },
  {
    name: 'a 403 is the deactivated account, before and after a retry',
    rules: [tokenRule(2), { ...ME, responses: [{ status: 403, text: 'Forbidden' }, { status: 401, text: 'x' }, { status: 403, text: 'Forbidden' }] }],
    steps: [fetchMe, fetchMe],
  },
  {
    name: 'a short 429 waits and retries; the daily limit is rate limited',
    rules: [
      tokenRule(1),
      {
        ...ME,
        responses: [
          { status: 429, text: 'slow', headers: { 'Retry-After': '1' } },
          ok(USER),
          { status: 429, text: '{"ok":false,"error":"Daily limit"}', headers: { 'Retry-After': '86400' } },
          { status: 429, text: 'slow', headers: { 'Retry-After': '2' } },
          { status: 429, text: 'slow', headers: { 'Retry-After': '2' } },
        ],
      },
    ],
    steps: [fetchMe, fetchMe, fetchMe],
  },
  {
    name: 'other failures pass the message on',
    rules: [tokenRule(1), { ...ME, responses: [{ status: 500, text: 'boom' }, { status: 404, text: 'gone' }, { status: 200, json: { ok: false, error: 'nope' } }] }],
    steps: [fetchMe, fetchMe, fetchMe],
  },
  {
    name: 'no Google sign-in sends nothing',
    rules: [],
    steps: [{ idToken: null }, fetchMe, { call: 'HUB_PATCH_AUTH_ME', args: ['Name'] }],
  },
  {
    name: 'failures of the token request',
    rules: [
      {
        method: 'POST',
        path: '/api/auth/token',
        responses: [
          { status: 409, text: 'taken' },
          { status: 403, text: 'banned' },
          { status: 429, text: 'limit', headers: { 'Retry-After': '120' } },
          { status: 401, text: 'bad id token' },
          { status: 200, json: { ok: false, error: 'Invalid token' } },
          { status: 500, text: '' },
        ],
      },
    ],
    steps: [
      { call: 'HUB_SET_AUTH_DISPLAY_NAME', args: ['Taken'] },
      fetchMe,
      fetchMe,
      fetchMe,
      fetchMe,
      fetchMe,
      { call: 'HUB_FETCH_MY_POSTS', args: [] },
    ],
  },
  {
    name: 'patching the display name',
    rules: [
      tokenRule(2),
      {
        ...PATCH_ME,
        responses: [
          ok({ ...USER, display_name: 'New' }),
          { status: 409, text: 'taken' },
          { status: 401, text: 'x' },
          { status: 409, text: 'taken' },
          { status: 400, text: 'bad' },
        ],
      },
    ],
    steps: [
      { call: 'HUB_PATCH_AUTH_ME', args: [' New '] },
      { call: 'HUB_PATCH_AUTH_ME', args: ['Taken'] },
      { call: 'HUB_PATCH_AUTH_ME', args: ['Taken'] },
      { call: 'HUB_PATCH_AUTH_ME', args: ['Bad'] },
      { call: 'HUB_PATCH_AUTH_ME', args: [''] },
      { call: 'HUB_PATCH_AUTH_ME', args: ['   '] },
      { call: 'HUB_PATCH_AUTH_ME', args: ['x'.repeat(51)] },
      { call: 'HUB_PATCH_AUTH_ME', args: [null] },
      { call: 'HUB_PATCH_AUTH_ME', args: [42] },
    ],
  },
]
