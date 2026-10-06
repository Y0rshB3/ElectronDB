import type { IpcEventChannel, IpcEventMap } from '@shared/ipc'
import type { CredentialStore } from './credentials/store'
import type { ConnectionsRepo, JobsRepo, RunsRepo, SettingsRepo } from './storage/repos'

/** Everything a feature module needs from the host application. */
export interface AppContext {
  userDataPath: string
  logDir: string
  connections: ConnectionsRepo
  jobs: JobsRepo
  runs: RunsRepo
  settings: SettingsRepo
  credentials: CredentialStore
  /** Broadcast a push event to every renderer window. */
  emit<E extends IpcEventChannel>(channel: E, payload: IpcEventMap[E]): void
  /** True when started with --run-job (no window). */
  headless: boolean
  /**
   * True when the profile was redirected with ELECTRONDB_USER_DATA. launchd
   * agents are global per macOS user, so an isolated profile neither
   * installs nor removes them (it would delete the real profile's agents).
   */
  isolatedProfile?: boolean
}
