/// <reference types="vite/client" />
import type { VortaqApi } from '@shared/ipc'

declare global {
  interface Window {
    vortaq: VortaqApi
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

export {}
