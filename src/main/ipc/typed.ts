import { ipcMain } from 'electron'
import type { IpcArgs, IpcChannel, IpcResult } from '@shared/ipc'
import { getLogger } from '../log'
import { describeForLog } from './errorLog'

export { describeForLog, IpcError } from './errorLog'

const log = getLogger('ipc')

/**
 * Registers a typed invoke handler. Errors are normalised to plain Error
 * messages so the renderer receives a readable text instead of a serialised
 * object with internals.
 */
export function handle<C extends IpcChannel>(
  channel: C,
  fn: (...args: IpcArgs<C>) => Promise<IpcResult<C>> | IpcResult<C>
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...(args as IpcArgs<C>))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`${channel} failed: ${describeForLog(err)}`)
      throw new Error(message)
    }
  })
}
