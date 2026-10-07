/* global process, console */
/**
 * Builds every release artifact into one folder, ready to upload by hand to a GitHub release.
 * It never publishes: electron-builder always runs with `--publish never` and without GitHub
 * tokens in its environment.
 *
 *   node scripts/release.mjs [--out <dir>] [--platforms mac,win,linux] [--skip-build] [--clean]
 *   npm run release:build -- --platforms win
 *
 * Default output: release/v<version>. Works on an Apple Silicon Mac without Rosetta (the NSIS
 * and AppImage toolsets are set in electron-builder.yml).
 *
 * Produces, besides the installers (names fixed by artifactName in electron-builder.yml):
 *   latest.yml, latest-linux.yml, latest-mac.yml   electron-updater feeds (sha512 of each file)
 *   *.blockmap                                     differential downloads
 *   SHA256SUMS.txt                                 SHA-256 of every installer (the macOS
 *                                                  in-app download refuses a .dmg without it)
 * Upload ALL of them with their exact names: latest*.yml point to these names, so renaming a
 * file breaks the in-app update.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  builderArgs,
  expectedArtifacts,
  expectedFeedFiles,
  hashFile,
  parseUpdateYml,
  PLATFORMS,
  sha256SumsText
} from './release-lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const opts = { out: null, platforms: [...PLATFORMS], build: true, clean: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') opts.out = argv[++i]
    else if (a === '--platforms') opts.platforms = argv[++i].split(',').map((s) => s.trim())
    else if (a === '--skip-build') opts.build = false
    else if (a === '--clean') opts.clean = true
    else if (a === '--publish' || a.startsWith('--publish='))
      throw new Error('release.mjs never publishes: upload the files of the output folder by hand.')
    else throw new Error(`Unknown option: ${a}`)
  }
  for (const p of opts.platforms)
    if (!PLATFORMS.includes(p))
      throw new Error(`Unknown platform "${p}" (use ${PLATFORMS.join(',')})`)
  return opts
}

function run(cmd, args, env) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env })
  if (res.status !== 0) throw new Error(`${cmd} failed (exit ${res.status ?? res.signal})`)
}

async function verifyFeed(outDir, platform, version) {
  const { updateInfo } = expectedArtifacts(version)[platform]
  const expected = expectedFeedFiles(version)[platform]
  const yml = parseUpdateYml(readFileSync(join(outDir, updateInfo), 'utf8'))
  if (yml.version !== version)
    throw new Error(`${updateInfo}: version ${yml.version}, expected ${version}`)
  if (expected.path && yml.path !== expected.path)
    throw new Error(`${updateInfo}: path ${yml.path}, expected ${expected.path}`)
  for (const name of expected.files) {
    const entry = yml.files.find((f) => f.url === name)
    if (!entry?.sha512) throw new Error(`${updateInfo}: no sha512 entry for ${name}`)
    const actual = await hashFile(join(outDir, name), 'sha512', 'base64')
    if (actual !== entry.sha512)
      throw new Error(`${updateInfo}: sha512 of ${name} does not match the file`)
  }
  console.log(`  ✓ ${updateInfo} → ${expected.files.join(', ')} (sha512 checked)`)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const outDir = resolve(ROOT, opts.out ?? join('release', `v${version}`))
  if (opts.clean) rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  // No tokens for electron-builder: even a misconfigured publish could not upload anything.
  const env = { ...process.env }
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_RELEASE_TOKEN']) delete env[k]

  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  if (opts.build) run(npm, ['run', 'build'], env)
  for (const platform of opts.platforms)
    run(npx, ['electron-builder', ...builderArgs(platform, outDir)], env)

  console.log(`\nVerifying ${outDir}`)
  const artifacts = expectedArtifacts(version)
  const upload = []
  const sums = []
  for (const platform of opts.platforms) {
    const a = artifacts[platform]
    for (const name of [...a.binaries, a.updateInfo, ...a.blockmaps])
      if (!existsSync(join(outDir, name))) throw new Error(`Missing ${name} in ${outDir}`)
    await verifyFeed(outDir, platform, version)
    for (const name of a.binaries)
      sums.push({ name, sha256: await hashFile(join(outDir, name), 'sha256', 'hex') })
    upload.push(...a.binaries, a.updateInfo, ...a.blockmaps)
  }
  writeFileSync(join(outDir, 'SHA256SUMS.txt'), sha256SumsText(sums))
  upload.push('SHA256SUMS.txt')

  console.log(`\nRelease v${version} built (nothing was published). Upload these files, unrenamed:`)
  for (const name of upload) console.log(`  ${join(outDir, name)}`)
  console.log('\nOptional: paste SHA256SUMS.txt into the release notes as well.')
}

main().catch((err) => {
  console.error(`\nrelease.mjs: ${err.message}`)
  process.exit(1)
})
