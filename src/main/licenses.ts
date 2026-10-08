import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AboutPanelOptionsOptions } from 'electron'
import type { AppLicenses } from '@shared/types'
import { APP_NAME, LEGACY_UPDATE_REPOS, UPDATE_REPO } from './brand'

/**
 * LICENSE and THIRD_PARTY_LICENSES.txt for «Acerca de Vortaq». Packaged builds
 * ship both as extraResources (process.resourcesPath); in development they
 * are the project's LICENSE and the notices `npm run build` writes to out/.
 * Pure Node (no electron) so it is unit tested.
 */

export const THIRD_PARTY_FILE = 'THIRD_PARTY_LICENSES.txt'

/** Public page of the project, opened by «Repositorio en GitHub». */
export const REPOSITORY_URL = `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.name}`

/**
 * What «Repositorio en GitHub» actually opens: the repository's earlier name,
 * which works before the rename to Vortaq and, through GitHub's redirect,
 * after it. REPOSITORY_URL stays the address shown to the user.
 */
export const REPOSITORY_OPEN_URL = LEGACY_UPDATE_REPOS[0]
  ? `https://github.com/${LEGACY_UPDATE_REPOS[0].owner}/${LEGACY_UPDATE_REPOS[0].name}`
  : REPOSITORY_URL

export interface LicensePathsInput {
  packaged: boolean
  /** process.resourcesPath */
  resourcesPath: string
  /** app.getAppPath(): the project folder in development. */
  appPath: string
}

export function licenseFilePaths(input: LicensePathsInput): {
  license: string
  thirdParty: string
} {
  return input.packaged
    ? {
        license: join(input.resourcesPath, 'LICENSE'),
        thirdParty: join(input.resourcesPath, THIRD_PARTY_FILE)
      }
    : {
        license: join(input.appPath, 'LICENSE'),
        thirdParty: join(input.appPath, 'out', THIRD_PARTY_FILE)
      }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Native «About» panel (macOS app menu; also used by Linux/Windows if shown). */
export function aboutPanelOptions(input: {
  version: string
  electron: string
  iconPath?: string
}): AboutPanelOptionsOptions {
  return {
    applicationName: APP_NAME,
    applicationVersion: input.version,
    version: `Electron ${input.electron}`,
    copyright: '© 2026 Y0rshB3 · Licencia MIT',
    credits:
      'Gestor de bases de datos de escritorio, independiente y de código abierto. ' +
      'Las licencias de terceros están en Más › Acerca de Vortaq.',
    website: REPOSITORY_URL,
    ...(input.iconPath ? { iconPath: input.iconPath } : {})
  }
}

export function readLicenses(input: LicensePathsInput): AppLicenses {
  const paths = licenseFilePaths(input)
  const thirdParty = readText(paths.thirdParty)
  return {
    license: readText(paths.license),
    thirdParty,
    thirdPartyPath: thirdParty === null ? null : paths.thirdParty,
    repositoryUrl: REPOSITORY_URL
  }
}
