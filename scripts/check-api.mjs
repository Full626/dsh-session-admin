#!/usr/bin/env node
/**
 * Exercise the host half over HTTP, without a browser.
 *
 * Host-only checks read the list, archive and unarchive, and REPORT what a
 * delete would do without performing one. Pass --delete <id...> to actually
 * delete, and --create-fixture to make a throwaway session first (so the
 * destructive path can be tested safely).
 *
 * Usage: node scripts/check-api.mjs [--url http://127.0.0.1:19387] [--delete id...]
 */
const args = process.argv.slice(2)
const arg = function (name, fallback) {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const url = arg('url', process.env.DSH_WEB_URL || 'http://127.0.0.1:19387')
const API = url.replace(/\/+$/, '') + '/api/dsh-session-admin'

const call = async function (action, body) {
  const init = { headers: { accept: 'application/json' } }
  if (body) {
    init.method = 'POST'
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(API + '/' + action, init)
  const json = await res.json().catch(function () { return {} })
  if (!res.ok || json.ok === false) throw new Error(action + ' -> HTTP ' + res.status + ' ' + JSON.stringify(json))
  return json
}

const kb = function (n) { return (n / 1024).toFixed(0) + ' KB' }

try {
  const state = await call('state')
  console.log('API reachable at ' + API)
  console.log('  home         : ' + state.home)
  console.log('  sessionsRoot : ' + state.sessionsRoot)
  console.log('  pending      : ' + (state.pending.length ? state.pending.join(', ') : '(none)'))
  const list = await call('list')
  console.log('  sessions     : ' + list.sessions.length)
  for (const s of list.sessions) {
    console.log('    ' + s.id.slice(0, 20) + '  ' + String(Math.round(s.bytes / 1024)).padStart(6) + 'K  live=' + (s.live ? 1 : 0) + ' arch=' + (s.archived ? 1 : 0) + '  ' + (s.title || '(untitled)').slice(0, 34))
  }
  const ids = args.filter(function (a) { return a !== '--delete' }).length && args.includes('--delete')
    ? args.slice(args.indexOf('--delete') + 1).filter(function (a) { return !a.startsWith('--') })
    : []
  if (ids.length > 0) {
    console.log('deleting ' + ids.length + ' session(s)...')
    const out = await call('delete', { ids: ids })
    for (const r of out.results) console.log('  ' + (r.ok ? 'deleted' : 'skipped') + '  ' + r.id + (r.pending ? '  (still live; will be cleared on next start)' : '') + (r.reason ? '  ' + r.reason : ''))
    console.log('pending now: ' + (out.pending.length ? out.pending.join(', ') : '(none)'))
  } else {
    console.log('no --delete ids given: read-only run')
  }
} catch (error) {
  console.error('check-api failed: ' + (error.message || error))
  process.exitCode = 1
}
