/* global Buffer */
/**
 * Pure helpers of scripts/release.mjs (unit tested in release-lib.test.ts, and used by the
 * opt-in dist integration test). No network, no publishing.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

export const PRODUCT = 'ElectronDB'
export const PACKAGE_NAME = 'electrondb'
export const PLATFORMS = ['mac', 'win', 'linux']

/** electron-builder arguments for one platform. Always `--publish never`. */
export function builderArgs(platform, outDir) {
  const common = [
    '--config',
    'electron-builder.yml',
    '--publish',
    'never',
    `-c.directories.output=${outDir}`
  ]
  switch (platform) {
    case 'mac':
      return ['--mac', '--arm64', '--x64', ...common]
    case 'win':
      return ['--win', '--x64', ...common]
    case 'linux':
      return ['--linux', '--x64', ...common]
    default:
      throw new Error(`Unknown platform: ${platform}`)
  }
}

/**
 * Files a release of `version` must contain, per platform: `binaries` (what users download,
 * listed in SHA256SUMS.txt), `updateInfo` (electron-updater feed) and `blockmaps`
 * (differential downloads). These names are what latest*.yml points to: never rename them.
 */
export function expectedArtifacts(version) {
  const p = `${PRODUCT}-${version}`
  return {
    mac: {
      binaries: [`${p}-arm64.dmg`, `${p}-x64.dmg`, `${p}-arm64-mac.zip`, `${p}-x64-mac.zip`],
      updateInfo: 'latest-mac.yml',
      blockmaps: [
        `${p}-arm64.dmg.blockmap`,
        `${p}-x64.dmg.blockmap`,
        `${p}-arm64-mac.zip.blockmap`,
        `${p}-x64-mac.zip.blockmap`
      ]
    },
    win: {
      binaries: [`${p}-x64-setup.exe`, `${p}-x64-portable.exe`],
      updateInfo: 'latest.yml',
      blockmaps: [`${p}-x64-setup.exe.blockmap`]
    },
    linux: {
      // The AppImage embeds its block map (no separate file).
      binaries: [`${p}-x86_64.AppImage`, `${PACKAGE_NAME}_${version}_amd64.deb`],
      updateInfo: 'latest-linux.yml',
      blockmaps: []
    }
  }
}

/** Files electron-updater must find in each feed (the installer it downloads first). */
export function expectedFeedFiles(version) {
  const p = `${PRODUCT}-${version}`
  return {
    mac: {
      // Not used by ElectronDB (macOS updates through the verified .dmg); order depends on the build.
      path: null,
      files: [`${p}-arm64-mac.zip`, `${p}-x64-mac.zip`, `${p}-arm64.dmg`, `${p}-x64.dmg`]
    },
    win: { path: `${p}-x64-setup.exe`, files: [`${p}-x64-setup.exe`] },
    linux: { path: `${p}-x86_64.AppImage`, files: [`${p}-x86_64.AppImage`] }
  }
}

/**
 * Minimal reader for electron-builder's latest*.yml (version, path, sha512 and the files
 * list). Enough to verify a build without a YAML dependency.
 */
export function parseUpdateYml(text) {
  const out = { version: null, path: null, sha512: null, files: [] }
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    const item = /^\s*-\s+url:\s*(.+?)\s*$/.exec(raw)
    if (item) {
      current = { url: unquote(item[1]), sha512: null, size: null }
      out.files.push(current)
      continue
    }
    const nested = /^\s{2,}(sha512|size):\s*(.+?)\s*$/.exec(raw)
    if (nested && current) {
      if (nested[1] === 'sha512') current.sha512 = unquote(nested[2])
      else current.size = Number(nested[2])
      continue
    }
    const top = /^(version|path|sha512):\s*(.+?)\s*$/.exec(raw)
    if (top) {
      out[top[1]] = unquote(top[2])
      current = null
    }
  }
  return out
}

const unquote = (v) => v.replace(/^['"]|['"]$/g, '')

export function hashFile(path, algorithm, encoding) {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm)
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest(encoding)))
  })
}

/** `sha256sum` format: "<hex>  <name>" per line, sorted by name. */
export function sha256SumsText(entries) {
  return (
    [...entries]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => `${e.sha256}  ${e.name}`)
      .join('\n') + '\n'
  )
}

/** Base64 sha512 as electron-builder writes it in latest*.yml. */
export function sha512Base64(buffer) {
  return createHash('sha512').update(Buffer.from(buffer)).digest('base64')
}
