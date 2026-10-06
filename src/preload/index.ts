import { contextBridge, ipcRenderer } from 'electron'
import { IPC_EVENT_CHANNELS, IPC_INVOKE_CHANNELS } from '@shared/ipc'
import type { ElectronDBApi } from '@shared/ipc'

const invokeChannels = new Set<string>(IPC_INVOKE_CHANNELS)
const eventChannels = new Set<string>(IPC_EVENT_CHANNELS)

const api: ElectronDBApi = {
  platform: process.platform,
  invoke: (channel, ...args) => {
    if (!invokeChannels.has(channel))
      return Promise.reject(new Error(`Unknown IPC channel ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel, listener) => {
    if (!eventChannels.has(channel)) throw new Error(`Unknown IPC event ${channel}`)
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown): void => {
      listener(payload as never)
    }
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

contextBridge.exposeInMainWorld('electronDB', api)
