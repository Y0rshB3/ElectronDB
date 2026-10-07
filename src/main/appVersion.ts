import { version } from '../../package.json'

/**
 * Version of this build, from package.json (the same value app.getVersion()
 * returns in the packaged app). Usable without electron (backups, tests).
 */
export const APP_VERSION: string = version
