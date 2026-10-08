import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { StartupNotice } from '@shared/types'
import { APP_NAME, LEGACY_ELECTRONDB } from '../brand'

/**
 * macOS: the ElectronDB app left installed after moving to Vortaq. Both apps
 * share the bundle id (electron-builder.yml), so keeping the old one makes
 * Launch Services, the Dock and «Abrir con» pick either. After an ElectronDB
 * migration Vortaq offers, once, to move it to the Trash; it never does so on
 * its own. Pure Node (no electron) so it is unit tested; ipc/app.ts calls
 * shell.trashItem only after the user clicks.
 */

export const LEGACY_APP_NOTICE = 'legacy-app-installed'

/** Where macOS users install apps: /Applications and ~/Applications. */
export function legacyAppCandidates(home: string): string[] {
  const bundle = `${LEGACY_ELECTRONDB.name}.app`
  return [join('/Applications', bundle), join(home, 'Applications', bundle)]
}

/** The .app bundle that contains `execPath` (…/X.app/Contents/MacOS/X), or null. */
export function bundleOf(execPath: string): string | null {
  const marker = `.app${sep}Contents${sep}`
  const at = execPath.indexOf(marker)
  return at < 0 ? null : execPath.slice(0, at + 4)
}

/** The bundle at `path` is ElectronDB's: its Info.plist names the ElectronDB executable. */
export function isElectronDbBundle(path: string, read = readFileSync): boolean {
  try {
    const plist = read(join(path, 'Contents', 'Info.plist'), 'utf8')
    return new RegExp(
      `<key>CFBundleExecutable</key>\\s*<string>${LEGACY_ELECTRONDB.name}</string>`
    ).test(plist)
  } catch {
    return false
  }
}

export interface LegacyAppSearch {
  platform: NodeJS.Platform
  home: string
  /**
   * VORTAQ_LEGACY_APP_PATHS (tests and screenshots only): bundles to check
   * instead of the real /Applications ones.
   */
  candidates?: string[] | null
  /** VORTAQ_USER_DATA is set: without explicit candidates nothing is checked. */
  scratchProfile: boolean
  /** process.execPath: the running app is never offered for the Trash. */
  execPath: string
  read?: typeof readFileSync
}

/** ElectronDB bundles still installed (macOS only), never the running app. */
export function installedLegacyApps(search: LegacyAppSearch): string[] {
  if (search.platform !== 'darwin' && !search.candidates?.length) return []
  const list = search.candidates?.length
    ? search.candidates
    : search.scratchProfile
      ? []
      : legacyAppCandidates(search.home)
  const running = bundleOf(search.execPath)
  const seen = new Set<string>()
  return list.filter((raw) => {
    const path = resolve(raw)
    if (seen.has(path) || (running && resolve(running) === path)) return false
    seen.add(path)
    return isElectronDbBundle(path, search.read)
  })
}

export function legacyAppNotice(paths: string[]): StartupNotice {
  const where = paths.join(' y ')
  return {
    id: LEGACY_APP_NOTICE,
    level: 'info',
    title: `${LEGACY_ELECTRONDB.name} sigue instalado`,
    message:
      `La aplicación ${LEGACY_ELECTRONDB.name} sigue en ${where}. ${APP_NAME} la sustituye y ` +
      'comparten identificador en macOS, así que conservar las dos puede abrir la antigua por error. ' +
      `Tus datos ya están en ${APP_NAME} y la carpeta de ${LEGACY_ELECTRONDB.name} no se toca: ` +
      'solo se mueve la aplicación a la Papelera, de donde puedes recuperarla.',
    action: { kind: 'trashLegacyApp', label: `Mover ${LEGACY_ELECTRONDB.name} a la Papelera` }
  }
}
