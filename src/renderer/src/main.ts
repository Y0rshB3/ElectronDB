import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { vuetify } from './plugins/vuetify'
import { reportError, wasNotified } from './utils/errors'
import { api } from './api'
import { useConnectionsStore } from './stores/connections'
import { useJobLogsStore } from './stores/jobLogs'
import { useJobsStore } from './stores/jobs'
import { useSettingsStore } from './stores/settings'
import { useTabsStore } from './stores/tabs'
import { useTreeStore } from './stores/tree'
import { useUiStore } from './stores/ui'
import { useUpdatesStore } from './stores/updates'
import { useWorkspace } from './composables/useWorkspace'
import { applyPlatformClass } from './utils/platform'
import '@mdi/font/css/materialdesignicons.css'
import '@fontsource-variable/inter/wght.css'
import '@fontsource-variable/jetbrains-mono/wght.css'
// Nebula design system: order matters (tokens -> globals -> Vuetify skin).
import './styles/tokens.css'
import './styles/global.css'
import './styles/vuetify-overrides.css'

// Before mounting: the toolbar's title-bar gutters depend on the OS.
applyPlatformClass()

const app = createApp(App)
const pinia = createPinia()

// Last-resort reporting: errors escaping components or floating promises reach
// the user once (api.invoke already notified its own failures) instead of only
// the devtools console. Messages only: never log row data or secrets.
app.config.errorHandler = (err) => reportError(err)
window.addEventListener('unhandledrejection', (event) => {
  if (wasNotified(event.reason)) event.preventDefault()
  else reportError(event.reason)
})

app.use(pinia).use(vuetify).mount('#app')

/**
 * Screenshot harness hook (src/main/screenshots.ts). The main process only
 * adds `?nd-screenshots=1` when ELECTRONDB_SCREENSHOTS and ELECTRONDB_USER_DATA are
 * set, so this is inert in normal runs. It exposes the stores so the harness
 * can drive the UI through the same actions a user would trigger.
 */
if (new URLSearchParams(window.location.search).get('nd-screenshots') === '1') {
  ;(window as unknown as { __electronDBShots: unknown }).__electronDBShots = {
    api,
    theme: vuetify.theme,
    ui: useUiStore(pinia),
    tabs: useTabsStore(pinia),
    tree: useTreeStore(pinia),
    connections: useConnectionsStore(pinia),
    settings: useSettingsStore(pinia),
    jobs: useJobsStore(pinia),
    jobLogs: useJobLogsStore(pinia),
    updates: useUpdatesStore(pinia),
    workspace: useWorkspace()
  }
}
