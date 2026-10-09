#!/usr/bin/env node
/**
 * Exercise the host half end to end against a THROWAWAY $DSH_HOME.
 *
 * Destructive paths must never be tested on real data, so this harness builds a
 * fake home, applies the real plugin to it with a minimal fake context, and
 * drives the route handler directly. It covers what actually matters:
 *
 *   - a delete MOVES the session into the trash rather than unlinking it
 *   - restore puts it back in its original workspace
 *   - purge and the 90-day retention really remove it
 *   - a live session is detached (so clients drop the row at once) and only an
 *     undetachable one leaves a tombstone for the next boot to replay
 *
 * Usage: node scripts/test-host.mjs
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import zlib from 'node:zlib'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = pathToFileURL(resolve(HERE, '..', 'lib', 'index.js')).href

let failures = 0
function check(label, ok, detail) {
  if (ok) { console.log('  ok   ' + label); return }
  failures += 1
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' -- ' + detail))
}

const root = join(tmpdir(), 'dsh-session-admin-test-' + Date.now())
const sessionsRoot = join(root, 'sessions')
const cacheRoot = join(root, 'storages', 'session_projcache', 'sessions')
const trashRoot = join(root, 'sessions-trash')
const bucket = '--C-Users-Test-Desktop--'

/** One appended record, stored as its own zstd frame - exactly like the real store. */
const frame = (record) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(record) + '\n'))

/**
 * Seed a stored session with the records the real store writes.
 *
 * Opening a conversation already appends bootstrap records, so
 * `{ user: false }` models one that was opened and never used, while the
 * default models one somebody actually talked in. Both are a few hundred bytes
 * long, which is exactly why size can never be the emptiness test.
 */
async function seed(id, title, opts = {}) {
  const dir = join(sessionsRoot, bucket, id)
  await mkdir(dir, { recursive: true })
  const frames = [
    frame({ type: 'session', version: 4, id: id, cwd: workspacePath }),
    frame({ type: 'permission/preset', seq: 0, data: { preset: 'workspace-write' } }),
    frame({ type: 'sandbox/mode', seq: 1, data: { mode: 'workspace-write' } }),
    frame({ type: 'session/end-seed', seq: 2, data: {} }),
  ]
  if (opts.user !== false) frames.push(frame({ type: 'user/message', seq: 3, data: { text: 'hi' } }))
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
  await mkdir(cacheRoot, { recursive: true })
  await writeFile(join(cacheRoot, id + '.json'), JSON.stringify({ record: { rows: { title: { val: title } } } }))
  return dir
}

/** Seed a trash entry whose retention window has already elapsed. */
async function seedExpired(id, daysAgo) {
  const deletedAt = Date.now() - daysAgo * 86400000
  const dir = join(trashRoot, String(deletedAt) + '-' + id)
  await mkdir(join(dir, 'session'), { recursive: true })
  await writeFile(join(dir, 'session', 'session.v4.jsonl.zstd'), Buffer.alloc(512, 3))
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ version: 1, id: id, bucket: bucket, workspace: 'x', title: 'expired one', bytes: 512, deletedAt: deletedAt }))
  return dir
}

function makeReq(method, url, body) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : []
  return {
    method: method,
    url: url,
    [Symbol.asyncIterator]() {
      let i = 0
      return { next: () => Promise.resolve(i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) }
    },
  }
}
function makeRes() {
  return {
    status: 0, payload: null,
    writeHead(s) { this.status = s },
    end(b) { this.payload = b ? JSON.parse(b) : null },
  }
}

// ---- fake services -----------------------------------------------------------
const live = new Set()
const archived = new Set()
const pinned = new Set()
const detached = []
const store = new Map()
const enterLive = (id) => {
  live.add(id)
  store.set(id, { detach: () => { detached.push(id); store.delete(id); live.delete(id) } })
}
// One workspace whose path matches what the seeded bucket decodes to, so
// attach/detach membership can be observed.
const workspacePath = join('C:', 'Users', 'Test', 'Desktop')
let membership = []
const attachCalls = []
const workspace = {
  id: 'ws-1',
  path: workspacePath,
  get sessionIds() { return membership.slice() },
  attachSession: async (id) => { attachCalls.push(id); if (!membership.includes(id)) membership.push(id) },
  detachSession: async (id) => { membership = membership.filter((x) => x !== id) },
}
const services = {
  sessions: { store: store, get: (id) => (live.has(id) ? { id: id } : undefined) },
  agents: { get: () => undefined },
  workspaceRegistry: {
    get archivedSessionIds() { return Array.from(archived) },
    get pinnedSessionIds() { return Array.from(pinned) },
    list: () => [workspace],
    archiveSession: async (id) => { archived.add(id) },
    unarchiveSession: async (id) => { archived.delete(id) },
    pinSession: async (id) => { pinned.add(id) },
    unpinSession: async (id) => { pinned.delete(id) },
  },
}
const routes = []
const fakeCtx = {
  logger: { info() {}, warn() {}, error() {} },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  get: (name) => services[name],
}
const call = async (method, action, body) => {
  const res = makeRes()
  await routes[0].handler(makeReq(method, '/api/dsh-session-admin/' + action, body), res)
  return res
}
const listDir = async (dir) => { try { return await readdir(dir) } catch { return [] } }

try {
  process.env.DSH_HOME = root
  const plugin = await import(ENTRY + '?t=' + Date.now())
  check('host half exports apply', typeof plugin.apply === 'function')
  check('host half declares name', plugin.name === 'dsh-session-admin', String(plugin.name))
  check('host half requires webServer only', JSON.stringify(plugin.inject) === '["webServer"]', JSON.stringify(plugin.inject))

  const keep = 'session-aaaa1111-0000-0000-0000-000000000001'
  const gone = 'session-bbbb2222-0000-0000-0000-000000000002'
  const liveId = 'session-cccc3333-0000-0000-0000-000000000003'
  const dirKeep = await seed(keep, 'keep me')
  const dirGone = await seed(gone, 'trash me')
  const dirLive = await seed(liveId, 'live one')
  // A conversation opened but never used: header only, exactly one frame.
  const blank = 'session-0000blank-0000-0000-0000-000000000000'
  const dirBlank = await seed(blank, '', { user: false })

  plugin.apply(fakeCtx)
  check('route registered under the expected prefix', routes.length === 1 && routes[0].path === '/api/dsh-session-admin')
  await new Promise((r) => setTimeout(r, 30))

  // ---- listing ---------------------------------------------------------------
  const listed = await call('GET', 'list')
  check('list returns 200', listed.status === 200, String(listed.status))
  check('list sees every stored session', listed.payload.sessions.length === 4, String(listed.payload.sessions.length))
  check('list reports titles', listed.payload.sessions.some((s) => s.title === 'trash me'))
  check('list decodes the workspace bucket exactly', listed.payload.sessions[0].workspace === workspacePath, listed.payload.sessions[0].workspace + ' vs ' + workspacePath)
  check('list advertises the retention window', listed.payload.retentionDays === 90, String(listed.payload.retentionDays))
  // The bug this guards: a real but untitled conversation is only a few hundred
  // bytes, so a byte-size heuristic hid it. Emptiness must come from the record
  // count, where a header-only log is exactly one frame.
  const blankRow = listed.payload.sessions.find((s) => s.id === blank)
  const contentRow = listed.payload.sessions.find((s) => s.id === keep)
  check('a header-only conversation is flagged empty', blankRow.empty === true, JSON.stringify(blankRow))
  // Both rows are only a few hundred bytes: size cannot tell them apart, the
  // presence of a user/message event can.
  check('the unused and the used rows are similarly small', Math.abs(blankRow.bytes - contentRow.bytes) < 512, blankRow.bytes + ' vs ' + contentRow.bytes)
  check('a small conversation with content is NOT empty', contentRow.empty === false, JSON.stringify(contentRow))
  check('exactly one session is flagged empty', listed.payload.sessions.filter((s) => s.empty).length === 1, String(listed.payload.sessions.filter((s) => s.empty).length))

  // ---- delete MOVES rather than unlinks --------------------------------------
  const del = await call('POST', 'delete', { ids: [gone] })
  check('delete reports ok', del.payload.results[0].ok === true, JSON.stringify(del.payload.results[0]))
  check('the session left the sessions tree', !existsSync(dirGone))
  check('its projection cache left too', !existsSync(join(cacheRoot, gone + '.json')))
  const trashEntries = await call('GET', 'trash')
  check('trash received exactly one entry', trashEntries.payload.entries.length === 1, String(trashEntries.payload.entries.length))
  const entry = trashEntries.payload.entries[0]
  check('trash entry keeps the id', entry.id === gone, String(entry.id))
  check('trash entry keeps the title', entry.title === 'trash me', String(entry.title))
  check('trash entry carries an expiry 90 days out', entry.expiresAt - entry.deletedAt === 90 * 86400000, String(entry.expiresAt - entry.deletedAt))
  check('trash entry keeps the original bucket', entry.workspace.includes('Users'), entry.workspace)
  check('no tombstone for a session that was not live', del.payload.pending.length === 0, JSON.stringify(del.payload.pending))

  // ---- restore puts it back ---------------------------------------------------
  const restored = await call('POST', 'restore', { ids: [gone] })
  check('restore reports ok', restored.payload.results[0].ok === true, JSON.stringify(restored.payload.results[0]))
  check('restore returned the session to its original bucket', existsSync(dirGone))
  check('restore returned the projection cache', existsSync(join(cacheRoot, gone + '.json')))
  check('restore emptied the trash entry', (await call('GET', 'trash')).payload.entries.length === 0)

  // ---- membership survives a delete + restore round trip ---------------------
  membership = [gone]
  await call('POST', 'delete', { ids: [blank] })
  await call('POST', 'purge', { ids: [blank] })
  await call('POST', 'delete', { ids: [gone] })
  check('delete detaches the session from its workspace', membership.includes(gone) === false, JSON.stringify(membership))
  const back = await call('POST', 'restore', { ids: [gone] })
  check('restore reports the re-attach', back.payload.results[0].reattached === true, JSON.stringify(back.payload.results[0]))
  check('the session is back in its original workspace', membership.includes(gone), JSON.stringify(membership))

  // ---- the repair pass fixes a session no workspace claims --------------------
  membership = membership.filter((x) => x !== keep)
  const reconciled = await call('POST', 'reconcile', {})
  check('reconcile reports what it attached', reconciled.payload.attached >= 1, String(reconciled.payload.attached))
  check('reconcile put the loose session back', membership.includes(keep), JSON.stringify(membership))

  // ---- purge cleans the membership up for good --------------------------------
  archived.add(gone)
  pinned.add(gone)
  membership.push(gone)
  await call('POST', 'delete', { ids: [gone] })
  await call('POST', 'purge', { ids: [gone] })
  check('purge also detaches the membership', membership.includes(gone) === false, JSON.stringify(membership))
  check('purge also leaves the archive set', archived.has(gone) === false, JSON.stringify(Array.from(archived)))
  check('purge also leaves the pinned set', pinned.has(gone) === false, JSON.stringify(Array.from(pinned)))
  await seed(gone, 'trash me')
  membership = membership.concat([gone])

  // ---- deleting a live session detaches it -----------------------------------
  enterLive(liveId)
  const delLive = await call('POST', 'delete', { ids: [liveId] })
  const liveResult = delLive.payload.results[0]
  check('live delete detached the host entry', liveResult.detached === true, JSON.stringify(liveResult))
  check('the store entry was really released', detached.includes(liveId))
  check('no tombstone needed once detached', delLive.payload.pending.length === 0, JSON.stringify(delLive.payload.pending))
  check('live session moved to the trash', (await call('GET', 'trash')).payload.entries.some((e) => e.id === liveId))
  await call('POST', 'restore', { ids: [liveId] })

  // ---- an undetachable live session keeps a tombstone ------------------------
  const stuck = 'session-eeee5555-0000-0000-0000-000000000005'
  await seed(stuck, 'stuck live one')
  live.add(stuck) // live, but with no store entry: detach cannot release it
  const delStuck = await call('POST', 'delete', { ids: [stuck] })
  check('undetachable live session is marked pending', delStuck.payload.results[0].pending === true, JSON.stringify(delStuck.payload.results[0]))
  check('undetachable live session keeps a tombstone', delStuck.payload.pending.includes(stuck), JSON.stringify(delStuck.payload.pending))
  // It writes itself back, exactly like the old failure mode.
  await seed(stuck, 'stuck live one')
  live.add(stuck)
  check('the blocked session is back on disk', existsSync(join(sessionsRoot, bucket, stuck)))
  live.delete(stuck)
  await call('GET', 'state')
  // Fresh process: the boot replay must move it to the trash.
  const plugin2 = await import(ENTRY + '?t=' + Date.now() + 'b')
  plugin2.apply({
    logger: { info() {}, warn() {}, error() {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    webServer: { register: () => () => {} },
    get: (name) => services[name],
  })
  await new Promise((r) => setTimeout(r, 60))
  check('boot replay moved the resurrected session to the trash', !existsSync(join(sessionsRoot, bucket, stuck)))
  check('boot replay left unrelated sessions alone', existsSync(dirKeep) && existsSync(dirGone))
  check('boot replay cleared its tombstone', (await call('GET', 'state')).payload.pending.length === 0, JSON.stringify((await call('GET', 'state')).payload.pending))

  // ---- purge and the retention window ----------------------------------------
  const purgedEntry = (await call('GET', 'trash')).payload.entries[0]
  await call('POST', 'purge', { ids: [purgedEntry.id] })
  check('purge removed the trash entry', (await call('GET', 'trash')).payload.entries.length === 0)
  check('purge removed the trashed files', (await listDir(trashRoot)).length === 0, JSON.stringify(await listDir(trashRoot)))

  const expiredDir = await seedExpired('session-ffff6666-0000-0000-0000-000000000006', 91)
  const freshDir = await seedExpired('session-9999aaaa-0000-0000-0000-000000000007', 10)
  check('an over-age entry is on disk before listing', existsSync(expiredDir))
  const afterList = await call('GET', 'trash')
  check('listing purged the over-age entry', !existsSync(expiredDir))
  check('listing kept the in-window entry', existsSync(freshDir))
  check('listing reports what it purged', afterList.payload.purged === 1, String(afterList.payload.purged))
  check('the in-window entry is listed', afterList.payload.entries.some((e) => e.id.endsWith('0007')))

  // ---- archive / unarchive ----------------------------------------------------
  const arch = await call('POST', 'archive', { ids: [keep] })
  check('archive ok', arch.status === 200 && archived.has(keep))
  const unarch = await call('POST', 'unarchive', { ids: [keep] })
  check('unarchive ok', unarch.status === 200 && !archived.has(keep))

  // ---- guards ------------------------------------------------------------------
  check('empty id list is rejected', (await call('POST', 'delete', { ids: [] })).status === 400)
  check('unknown id reports not-found', (await call('POST', 'delete', { ids: ['session-nope'] })).payload.results[0].reason === 'not-found')
  check('restoring an unknown entry is a no-op', (await call('POST', 'restore', { ids: ['session-nope'] })).payload.results.length === 0)
  check('unknown action returns 404', (await call('GET', 'bogus')).status === 404)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nsession-admin: all host checks passed' : '\nsession-admin: ' + failures + ' check(s) FAILED')
process.exitCode = failures === 0 ? 0 : 1
