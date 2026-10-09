/**
 * dsh-session-admin - host half.
 *
 * Session administration for DSH: list, archive, unarchive, move sessions to a
 * 90-day trash, restore them, or purge them for good.
 *
 * Two things this file gets right that a naive "really delete" plugin does not:
 *
 * 1. DSH 0.2.x has no delete API at all. sessionPersistence offers
 *    create/open/stat/list/flush and the sessions service offers
 *    create/prepare/enter/announce/flush/get/list/fork - no removal. So a
 *    deletion can only move the artifacts on disk.
 *
 * 2. A session still held in the host's memory ("live") writes itself back
 *    afterwards, so a deleted chat reappears after a restart. Deleting therefore
 *    detaches the live entry first - which also makes every connected client
 *    drop the row immediately, because detach emits the official
 *    session/disposed event - and only if the host still owns the id does a
 *    TOMBSTONE get recorded for the next start to replay.
 *
 * Because deletion is destructive and irreversible, it is a MOVE into
 * $DSH_HOME/sessions-trash, kept for 90 days. Nothing here touches private DSH
 * APIs: the filesystem is the contract, plus two optional services
 * (workspaceRegistry for the archive set, sessions for liveness and detach).
 */
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'dsh-session-admin'

/** The web server carries the API; every other service is optional. */
export const inject = ['webServer']

/** Base path the browser half calls. */
const ROUTE = '/api/dsh-session-admin'
/** How long a trashed session is kept before it is purged automatically. */
const RETENTION_DAYS = 90
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000
/** Bumped if the tombstone file ever changes shape. */
const STATE_VERSION = 1
/** Every appended record is its own zstd frame; this is where one starts. */
const ZSTD_MAGIC = Buffer.from('28b52ffd', 'hex')
/** Above this size a log certainly holds a conversation, and scanning it is not cheap. */
const SCAN_LIMIT_BYTES = 262144
/** The one event type that proves a person actually used the conversation. */
const USER_MESSAGE_MARKER = '"user/message"'

function resolveHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.length > 0) return resolve(env)
  return join(homedir(), '.dsh')
}

/**
 * Decode a workspace bucket directory name back into the path it stands for.
 *
 * The encoding drops what a directory name cannot hold, so the drive letter
 * comes back as "C-Users-..." and the colon has to be restored: without it no
 * path comparison against a real workspace path can ever match, which is what
 * made a restored session land in "ungrouped".
 */
function decodeBucket(bucket) {
  const inner = bucket.replace(/^-+|-+$/g, '')
  const decoded = inner.replace(/~([0-9A-Fa-f]{4})/g, function (_m, hex) {
    return String.fromCharCode(parseInt(hex, 16))
  })
  const path = decoded.split('-').join(sep)
  const drive = /^([A-Za-z])\\(.*)$/.exec(path)
  return drive ? drive[1] + ':' + sep + drive[2] : path
}

export function apply(ctx) {
  const home = resolveHome()
  const sessionsRoot = resolve(home, 'sessions')
  const cacheRoot = resolve(home, 'storages', 'session_projcache', 'sessions')
  const stateDir = resolve(home, 'storages', 'session-admin')
  const tombstoneFile = join(stateDir, 'tombstones.json')
  const trashRoot = resolve(home, 'sessions-trash')
  const logger = ctx.logger ?? console

  const service = (n) => { try { return ctx.get(n) } catch { return undefined } }
  /** Keep every computed path inside its intended root. */
  const inside = (root, child) => child === root || child.startsWith(root + sep)

  // ------------------------------------------------------------------ state --
  async function loadTombstones() {
    try {
      const parsed = JSON.parse(await readFile(tombstoneFile, 'utf8'))
      if (parsed && parsed.version === STATE_VERSION && Array.isArray(parsed.ids)) {
        return parsed.ids.filter(function (x) { return typeof x === 'string' })
      }
    } catch {}
    return []
  }

  async function saveTombstones(ids) {
    await mkdir(stateDir, { recursive: true })
    await writeFile(tombstoneFile, JSON.stringify({ version: STATE_VERSION, ids: Array.from(new Set(ids)), updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8')
  }

  // --------------------------------------------------------------- scanning --
  async function scanStored() {
    const found = []
    let buckets = []
    try { buckets = await readdir(sessionsRoot) } catch { return found }
    for (const bucket of buckets) {
      const bucketDir = resolve(sessionsRoot, bucket)
      if (!inside(sessionsRoot, bucketDir)) continue
      let ids = []
      try { ids = await readdir(bucketDir) } catch { continue }
      for (const id of ids) {
        const dir = resolve(bucketDir, id)
        if (!inside(sessionsRoot, dir)) continue
        const info = await stat(dir).catch(() => null)
        if (!info || !info.isDirectory()) continue
        const files = await readdir(dir).catch(() => [])
        let bytes = 0
        let newest = 0
        for (const f of files) {
          const s = await stat(join(dir, f)).catch(() => null)
          if (s) { bytes += s.size; newest = Math.max(newest, s.mtimeMs) }
        }
        found.push({ id: id, dir: dir, bucket: bucket, workspace: decodeBucket(bucket), files: files.length, bytes: bytes, modifiedAt: newest })
      }
    }
    return found
  }

  /** Read the projected title out of the projection cache. */
  async function readTitle(id, cacheDir) {
    try {
      const parsed = JSON.parse(await readFile(join(cacheDir ?? cacheRoot, id + '.json'), 'utf8'))
      const val = parsed?.record?.rows?.title?.val
      if (typeof val === 'string') return val
      if (val && typeof val.text === 'string') return val.text
    } catch {}
    return ''
  }

  /**
   * Whether a stored session ever received a user message.
   *
   * This is the only honest test for "unused". Neither byte size nor record
   * count works: opening a conversation already writes bootstrap records
   * (permission/preset, sandbox/mode, approval/policy, session/end-seed), so an
   * untouched session is several hundred bytes and several records long - and
   * the greeting shown in the UI is never persisted at all. Only a real
   * "user/message" event means somebody actually talked in it.
   *
   * Unknown cases (a log too large to scan, or no zstd support) report true, so
   * a real conversation is never hidden.
   */
  async function hasUserMessage(entry) {
    if (entry.bytes > SCAN_LIMIT_BYTES) return true
    if (typeof zstdDecompressSync !== 'function') return true
    for (const name of await readdir(entry.dir).catch(() => [])) {
      if (!name.includes('jsonl')) continue
      let raw
      try { raw = await readFile(join(entry.dir, name)) } catch { continue }
      let at = 0
      while ((at = raw.indexOf(ZSTD_MAGIC, at)) !== -1) {
        // A byte pattern inside a payload is not a frame; decoding failing is the filter.
        try {
          if (zstdDecompressSync(raw.subarray(at)).toString('utf8').includes(USER_MESSAGE_MARKER)) return true
        } catch {}
        at += 1
      }
    }
    return false
  }

  function isLive(id) {
    const sessions = service('sessions')
    try { return !!(sessions && typeof sessions.get === 'function' && sessions.get(id)) } catch { return false }
  }

  function isRunning(id) {
    const agents = service('agents')
    try { return !!(agents && typeof agents.get === 'function' && agents.get(id)?.status === 'running') } catch { return false }
  }

  function archivedIds() {
    const registry = service('workspaceRegistry')
    try { return registry && Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds.map(String) : [] } catch { return [] }
  }

  /**
   * Remove a session from the host's live store. That is what makes the GUI
   * forget it: entry.detach() -> detachEntered -> emitDisposed -> every client
   * drops the row at once instead of waiting for a restart.
   */
  function detachLive(id) {
    const sessions = service('sessions')
    if (!sessions || !(sessions.store instanceof Map)) return false
    try {
      const entry = sessions.store.get(id)
      if (entry && typeof entry.detach === 'function') { entry.detach(); return true }
    } catch (error) {
      logger.warn?.('session-admin: detach failed', id, error)
    }
    return false
  }

  // ------------------------------------------------------------- trash store --
  /** Move a path, falling back to copy+remove when rename cannot cross devices. */
  async function movePath(from, to) {
    await mkdir(resolve(to, '..'), { recursive: true })
    try {
      await rename(from, to)
    } catch {
      await cp(from, to, { recursive: true })
      await rm(from, { recursive: true, force: true })
    }
  }

  /** Move one stored session (and its projection cache) into the trash. */
  async function moveToTrash(entry) {
    const deletedAt = Date.now()
    const dirName = String(deletedAt) + '-' + entry.id
    const dest = resolve(trashRoot, dirName)
    if (!inside(trashRoot, dest)) throw new Error('trash path escaped its root')
    const title = await readTitle(entry.id)
    await mkdir(dest, { recursive: true })
    await movePath(entry.dir, join(dest, 'session'))
    const cacheFile = join(cacheRoot, entry.id + '.json')
    if (existsSync(cacheFile)) await movePath(cacheFile, join(dest, 'cache.json'))
    const meta = {
      version: 1,
      id: entry.id,
      bucket: entry.bucket,
      workspace: entry.workspace,
      title: title,
      bytes: entry.bytes,
      deletedAt: deletedAt,
    }
    await writeFile(join(dest, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8')
    return dirName
  }

  async function readTrash() {
    const out = []
    let names = []
    try { names = await readdir(trashRoot) } catch { return out }
    for (const name of names) {
      const dir = resolve(trashRoot, name)
      if (!inside(trashRoot, dir)) continue
      try {
        const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))
        out.push(Object.assign({ dirName: name, dir: dir }, meta))
      } catch {}
    }
    out.sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0))
    return out
  }

  /** Permanently remove trash entries older than the retention window. */
  async function purgeExpired() {
    const cutoff = Date.now() - RETENTION_MS
    let purged = 0
    for (const item of await readTrash()) {
      if ((item.deletedAt || 0) < cutoff) {
        await rm(item.dir, { recursive: true, force: true }).catch(() => {})
        purged += 1
      }
    }
    return purged
  }

  async function restoreEntry(item) {
    const from = join(item.dir, 'session')
    if (existsSync(from)) {
      const bucketDir = resolve(sessionsRoot, item.bucket)
      if (!inside(sessionsRoot, bucketDir)) throw new Error('restore path escaped the sessions root')
      await mkdir(bucketDir, { recursive: true })
      await movePath(from, join(bucketDir, item.id))
    }
    const cached = join(item.dir, 'cache.json')
    if (existsSync(cached)) {
      await mkdir(cacheRoot, { recursive: true })
      await movePath(cached, join(cacheRoot, item.id + '.json'))
    }
    // Put it back under its original workspace, or it would land in "ungrouped".
    const reattached = await attachToWorkspace(item.id, item.workspace)
    await rm(item.dir, { recursive: true, force: true })
    return reattached
  }

  // -------------------------------------------------------------- mutations --
  /** Compare two filesystem paths the way Windows does. */
  function samePath(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false
    return resolve(a).replace(/[\\/]+$/, '').toLowerCase() === resolve(b).replace(/[\\/]+$/, '').toLowerCase()
  }

  /**
   * Put a session back into the workspace it belongs to.
   *
   * Deleting has to detach: a workspace's sessionIds getter is filtered through
   * an in-memory path index, so without the detach a trashed row can linger in
   * the sidebar. The cost is that the membership record is gone, and a restore
   * that only moves the files back lands in "ungrouped". This is the other half.
   */
  async function attachToWorkspace(id, workspacePath) {
    const registry = service('workspaceRegistry')
    if (!registry || typeof registry.list !== 'function') return false
    let workspaces = []
    try { workspaces = registry.list() } catch { return false }
    for (const workspace of workspaces) {
      const path = workspace.path ?? workspace.record?.path
      if (!samePath(path, workspacePath)) continue
      const ids = workspace.sessionIds ? Array.from(workspace.sessionIds).map(String) : []
      if (ids.includes(String(id))) return true
      if (typeof workspace.attachSession !== 'function') continue
      try { await workspace.attachSession(id); return true } catch (error) {
        logger.warn?.('session-admin: attach failed', id, error)
      }
    }
    return false
  }

  /**
   * Self-healing pass: any stored session that no workspace claims, but whose
   * folder matches a workspace path, is re-attached. This repairs sessions that
   * an earlier build trashed and restored without restoring membership.
   */
  async function reconcileMembership() {
    const registry = service('workspaceRegistry')
    if (!registry || typeof registry.list !== 'function') return 0
    let workspaces = []
    try { workspaces = registry.list() } catch { return 0 }
    const claimed = new Set()
    for (const workspace of workspaces) {
      const ids = workspace.sessionIds ? Array.from(workspace.sessionIds) : []
      for (const id of ids) claimed.add(String(id))
    }
    let attached = 0
    for (const entry of await scanStored()) {
      if (claimed.has(entry.id)) continue
      if (await attachToWorkspace(entry.id, entry.workspace)) attached += 1
    }
    return attached
  }

  /**
   * Best-effort: leave every registry set that still names this session.
   *
   * The regression state lives in three places, and leaving any of them behind
   * plants a ghost id for a conversation that no longer exists:
   *   - global.archivedSessionIds  -> unarchiveSession
   *   - global.pinnedSessionIds    -> unpinSession
   *   - workspaces.*.sessionIds    -> detachSession
   */
  async function forget(id) {
    const registry = service('workspaceRegistry')
    if (!registry) return
    try {
      if (typeof registry.unarchiveSession === 'function') await registry.unarchiveSession(id)
    } catch (error) { logger.warn?.('session-admin: unarchive failed', id, error) }
    try {
      if (typeof registry.unpinSession === 'function') await registry.unpinSession(id)
    } catch (error) { logger.warn?.('session-admin: unpin failed', id, error) }
    try {
      if (typeof registry.list === 'function') {
        for (const workspace of registry.list()) {
          const ids = workspace && workspace.sessionIds ? workspace.sessionIds : []
          if (Array.from(ids).some((x) => String(x) === id) && typeof workspace.detachSession === 'function') {
            await workspace.detachSession(id)
          }
        }
      }
    } catch (error) { logger.warn?.('session-admin: workspace detach failed', id, error) }
  }

  /** Move the given ids to the trash, detaching live ones first. */
  async function deleteIds(ids) {
    const stored = await scanStored()
    const byId = new Map(stored.map((s) => [s.id, s]))
    const tombstones = await loadTombstones()
    const results = []
    for (const id of ids) {
      const entry = byId.get(id)
      if (!entry) { results.push({ id: id, ok: false, reason: 'not-found' }); continue }
      if (isRunning(id)) { results.push({ id: id, ok: false, reason: 'running' }); continue }
      const live = isLive(id)
      // Detach first: the official removal path, so clients drop the row at once.
      const detached = live ? detachLive(id) : false
      if (isLive(id)) {
        if (!tombstones.includes(id)) tombstones.push(id)
      } else {
        const at = tombstones.indexOf(id)
        if (at >= 0) tombstones.splice(at, 1)
      }
      try {
        const dirName = await moveToTrash(entry)
        await forget(id)
        results.push({ id: id, ok: true, live: live, detached: detached, trashed: dirName, pending: isLive(id) })
      } catch (error) {
        results.push({ id: id, ok: false, reason: 'file-error', message: String(error && error.message ? error.message : error) })
      }
    }
    await saveTombstones(tombstones)
    return results
  }

  /** Replay tombstones: move back-again artifacts to the trash for good. */
  async function replayTombstones() {
    const tombstones = await loadTombstones()
    if (tombstones.length === 0) return { checked: 0, trashed: 0, kept: 0 }
    const stored = await scanStored()
    const byId = new Map(stored.map((s) => [s.id, s]))
    const kept = []
    let trashed = 0
    for (const id of tombstones) {
      const entry = byId.get(id)
      if (entry && !isLive(id)) {
        try { await moveToTrash(entry); await forget(id); trashed += 1 } catch {}
      }
      if (isLive(id)) kept.push(id)
    }
    if (kept.length !== tombstones.length) await saveTombstones(kept)
    return { checked: tombstones.length, trashed: trashed, kept: kept.length }
  }

  // ------------------------------------------------------------------ routes --
  const send = (res, status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  async function readJsonBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 262144) throw new Error('request body too large')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  async function listPayload() {
    const stored = await scanStored()
    const archived = archivedIds()
    const sessions = []
    for (const entry of stored) {
      sessions.push({
        id: entry.id,
        title: await readTitle(entry.id),
        workspace: entry.workspace,
        bytes: entry.bytes,
        files: entry.files,
        modifiedAt: entry.modifiedAt,
        archived: archived.includes(entry.id),
        live: isLive(entry.id),
        running: isRunning(entry.id),
      })
    }
    // Flag conversations nobody ever spoke in, so the UI can fold that noise
    // away without ever hiding a real one.
    for (let i = 0; i < sessions.length; i += 1) {
      sessions[i].empty = !(await hasUserMessage(stored[i]))
    }
    sessions.sort((a, b) => b.modifiedAt - a.modifiedAt)
    return { sessions: sessions, pending: await loadTombstones(), home: home, retentionDays: RETENTION_DAYS }
  }

  async function trashPayload() {
    const purged = await purgeExpired()
    const entries = (await readTrash()).map((item) => ({
      dirName: item.dirName,
      id: item.id,
      title: item.title || '',
      workspace: item.workspace || '',
      bytes: item.bytes || 0,
      deletedAt: item.deletedAt || 0,
      expiresAt: (item.deletedAt || 0) + RETENTION_MS,
    }))
    return { entries: entries, retentionDays: RETENTION_DAYS, purged: purged }
  }

  const readIds = (body) => Array.isArray(body.ids) ? body.ids.map(String).filter((x) => x.length > 0) : []

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.invalid')
        const action = url.pathname.slice(ROUTE.length).replace(/^\/+/, '')
        if (req.method === 'GET' && action === 'list') return send(res, 200, await listPayload())
        if (req.method === 'GET' && action === 'trash') return send(res, 200, await trashPayload())
        if (req.method === 'GET' && action === 'state') {
          return send(res, 200, { pending: await loadTombstones(), home: home, sessionsRoot: sessionsRoot, trashRoot: trashRoot, retentionDays: RETENTION_DAYS })
        }
        if (req.method !== 'POST') return send(res, 404, { ok: false, error: 'unknown action: ' + action })

        const body = await readJsonBody(req)

        if (action === 'delete') {
          const ids = readIds(body)
          if (ids.length === 0) return send(res, 400, { ok: false, error: 'no ids given' })
          return send(res, 200, { ok: true, results: await deleteIds(ids), pending: await loadTombstones() })
        }

        if (action === 'restore' || action === 'purge') {
          const ids = readIds(body)
          if (ids.length === 0) return send(res, 400, { ok: false, error: 'no ids given' })
          const wanted = new Set(ids)
          const results = []
          for (const item of await readTrash()) {
            if (!wanted.has(item.id) && !wanted.has(item.dirName)) continue
            try {
              if (action === 'restore') {
                const reattached = await restoreEntry(item)
                results.push({ id: item.id, dirName: item.dirName, ok: true, reattached: reattached })
              } else {
                await rm(item.dir, { recursive: true, force: true })
                await forget(item.id)
                results.push({ id: item.id, dirName: item.dirName, ok: true })
              }
            } catch (error) {
              results.push({ id: item.id, dirName: item.dirName, ok: false, reason: String(error && error.message ? error.message : error) })
            }
          }
          return send(res, 200, { ok: true, action: action, results: results, trash: await trashPayload() })
        }

        if (action === 'reconcile') {
          return send(res, 200, { ok: true, attached: await reconcileMembership() })
        }

        if (action === 'purge-expired') {
          return send(res, 200, { ok: true, purged: await purgeExpired(), trash: await trashPayload() })
        }

        if (action === 'archive' || action === 'unarchive') {
          const ids = readIds(body)
          if (ids.length === 0) return send(res, 400, { ok: false, error: 'no ids given' })
          const registry = service('workspaceRegistry')
          if (!registry || typeof registry.archiveSession !== 'function') {
            return send(res, 503, { ok: false, error: 'workspaceRegistry is not available in this composition' })
          }
          const results = []
          for (const id of ids) {
            try {
              if (action === 'archive') await registry.archiveSession(id)
              else await registry.unarchiveSession(id)
              results.push({ id: id, ok: true })
            } catch (error) {
              results.push({ id: id, ok: false, reason: String(error && error.message ? error.message : error) })
            }
          }
          return send(res, 200, { ok: true, action: action, results: results })
        }

        return send(res, 404, { ok: false, error: 'unknown action: ' + action })
      } catch (error) {
        logger.warn?.('session-admin: request failed', error)
        return send(res, 400, { ok: false, error: String(error && error.message ? error.message : error) })
      }
    },
  }), 'dsh-session-admin: API routes')

  // ---------------------------------------------------------------- startup --
  // Pass 1 activates immediately; pass 2 runs a few seconds later, because the
  // host may still be restoring the previously open session. Both also enforce
  // the retention window, so the trash never grows past 90 days.
  const boot = async (label) => {
    try {
      const replayed = await replayTombstones()
      const purged = await purgeExpired()
      const attached = await reconcileMembership()
      if (replayed.checked > 0 || purged > 0 || attached > 0) {
        logger.info?.('session-admin: ' + label, replayed, { purged: purged, attached: attached })
      }
    } catch (error) { logger.warn?.('session-admin: ' + label + ' failed', error) }
  }
  boot('boot pass')
  const settle = setTimeout(() => { boot('delayed pass') }, 5000)
  if (typeof settle.unref === 'function') settle.unref()
  ctx.effect(() => () => clearTimeout(settle), 'dsh-session-admin: delayed pass')
}
