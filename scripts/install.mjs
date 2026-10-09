#!/usr/bin/env node
/**
 * Install (or uninstall) dsh-session-admin for one dsh profile.
 *
 * Like every DSH plugin this package is a BUNDLE: it ships cordis.patch.yml,
 * which the profile loader applies once the package name is selected in the
 * profile's dsh.profile.bundles. So this script only:
 *
 *   1. copies the package where the profile resolves it
 *      (<profile>/node_modules/<name>)
 *   2. appends <name> to <profile>/package.json -> dsh.profile.bundles
 *
 * The preferable route keeps pnpm's install state authoritative:
 *   desktop app : sidebar -> Plugins -> install, paste the repo URL
 *   any profile : dsh plugin --profile <name> add <spec>
 *
 * Usage:
 *   node scripts/install.mjs [--dsh-home <dir>] [--profile desktop] [--dry-run] [--uninstall]
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = resolve(HERE, '..')
const COPIED = ['package.json', 'cordis.patch.yml', 'dsh.plugin.json', 'LICENSE', 'README.md', 'lib', 'scripts']

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i += 1 } else { out[key] = true }
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const manifest = JSON.parse(await readFile(join(PACKAGE_DIR, 'package.json'), 'utf8'))
  const pluginId = manifest.name
  if (!manifest.dsh || !manifest.dsh.bundle || !manifest.dsh.bundle.patch) {
    throw new Error('package.json has no dsh.bundle.patch, so this package is not a bundle')
  }
  const dshHome = args['dsh-home'] ?? process.env.DSH_HOME
  if (typeof dshHome !== 'string' || dshHome.length === 0) throw new Error('no dsh home: pass --dsh-home <dir> or set $env:DSH_HOME')
  const profile = typeof args.profile === 'string' ? args.profile : (process.env.DSH_PROFILE || 'desktop')
  const dryRun = args['dry-run'] === true
  const uninstall = args.uninstall === true

  const profileDir = join(resolve(dshHome), 'profiles', profile)
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) throw new Error('no profile at ' + profileDir)
  if (!uninstall && !existsSync(join(PACKAGE_DIR, 'lib', 'client.js'))) throw new Error('lib/client.js is missing')

  const original = await readFile(manifestPath, 'utf8')
  const parsed = JSON.parse(original)
  parsed.dsh = parsed.dsh || {}
  parsed.dsh.profile = parsed.dsh.profile || {}
  const bundles = Array.isArray(parsed.dsh.profile.bundles) ? parsed.dsh.profile.bundles : []
  const next = uninstall
    ? bundles.filter(function (name) { return name !== pluginId })
    : (bundles.includes(pluginId) ? bundles : bundles.concat([pluginId]))
  parsed.dsh.profile.bundles = next
  const rendered = JSON.stringify(parsed, void 0, 2) + '\n'

  console.log('session-admin: home    ' + resolve(dshHome))
  console.log('session-admin: profile ' + profile)
  console.log('session-admin: bundles [' + bundles.join(', ') + '] -> [' + next.join(', ') + ']')
  if (dryRun) { console.log('dry run: nothing was written'); return }

  const backup = manifestPath + '.session-admin-backup'
  if (rendered !== original && !existsSync(backup)) await writeFile(backup, original, 'utf8')

  const target = join(profileDir, 'node_modules', pluginId)
  if (uninstall) {
    if (existsSync(target)) await rm(target, { recursive: true, force: true })
    await writeFile(manifestPath, rendered, 'utf8')
    console.log('session-admin: uninstalled. Restart the app so the profile composes without it.')
    return
  }
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  for (const entry of COPIED) {
    const from = join(PACKAGE_DIR, entry)
    if (!existsSync(from)) continue
    await cp(from, join(target, entry), { recursive: true })
  }
  await writeFile(manifestPath, rendered, 'utf8')
  console.log('session-admin: installed as a bundle.')
  console.log('session-admin: restart the app so the new bundle layer is composed, then refresh.')
}

main().catch(function (error) { console.error('session-admin: ' + error.message); process.exitCode = 1 })
