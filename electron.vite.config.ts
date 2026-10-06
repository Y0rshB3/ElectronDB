import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'

export default defineConfig({
  main: {
    // plist v5 is ESM-only (no "require" export), so the CJS main bundle must inline it.
    plugins: [externalizeDepsPlugin({ exclude: ['plist'] })],
    resolve: {
      alias: { '@shared': resolve('src/shared'), '@main': resolve('src/main') }
    },
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } }
    }
  },
  renderer: {
    resolve: {
      alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') }
    },
    plugins: [vue(), vuetify({ autoImport: true })],
    // vite-plugin-vuetify adds component imports while transforming each view, so Vite's
    // dependency scanner cannot see them up front. Optimizing vuetify made the dev server
    // "discover" components the first time a view opened and reload the whole window,
    // which reset the UI state (open connections appeared closed). Vuetify ships ESM,
    // so serving it unoptimized is the setup its docs recommend.
    optimizeDeps: { exclude: ['vuetify'] }
  }
})
