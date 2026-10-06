/// <reference types="vite/client" />
import type { ElectronDBApi } from '@shared/ipc'

declare global {
  interface Window {
    electronDB: ElectronDBApi
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

export {}
