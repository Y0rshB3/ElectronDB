<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { useTheme } from 'vuetify'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore } from '@renderer/stores/ui'
import { loadInitialData, subscribeToMainEvents } from '@renderer/composables/useAppBootstrap'
import { useShortcuts } from '@renderer/composables/useShortcuts'
import AppToolbar from '@renderer/components/layout/AppToolbar.vue'
import ConnectionTree from '@renderer/components/layout/ConnectionTree.vue'
import WorkspaceTabs from '@renderer/components/layout/WorkspaceTabs.vue'
import InfoPanel from '@renderer/components/layout/InfoPanel.vue'
import AiPanel from '@renderer/components/ai/AiPanel.vue'
import StatusBar from '@renderer/components/layout/StatusBar.vue'
import ProgressOverlay from '@renderer/components/layout/ProgressOverlay.vue'
import LogDrawer from '@renderer/components/layout/LogDrawer.vue'
import PaneSplitter from '@renderer/components/layout/PaneSplitter.vue'
import ConfirmHost from '@renderer/components/common/ConfirmHost.vue'
import NotifyHost from '@renderer/components/common/NotifyHost.vue'
import ConnectionDialog from '@renderer/components/dialogs/ConnectionDialog.vue'
import ImportNavicatDialog from '@renderer/components/dialogs/ImportNavicatDialog.vue'
import ImportWizard from '@renderer/components/import/ImportWizard.vue'
import SettingsDialog from '@renderer/components/dialogs/SettingsDialog.vue'
import AboutDialog from '@renderer/components/dialogs/AboutDialog.vue'
import NewDatabaseDialog from '@renderer/components/dialogs/NewDatabaseDialog.vue'
import BackupDialog from '@renderer/components/dialogs/BackupDialog.vue'
import RestoreDialog from '@renderer/components/dialogs/RestoreDialog.vue'
import UpdateDialog from '@renderer/components/updates/UpdateDialog.vue'
import UpdateNotice from '@renderer/components/updates/UpdateNotice.vue'
import WhatsNewDialog from '@renderer/components/updates/WhatsNewDialog.vue'
import TourHost from '@renderer/components/tour/TourHost.vue'
import { useTourStore } from '@renderer/stores/tour'
import { useUpdatesStore } from '@renderer/stores/updates'
import { useWhatsNewStore } from '@renderer/stores/whatsNew'

const ui = useUiStore()
const settings = useSettingsStore()
const theme = useTheme()
const updates = useUpdatesStore()
const whatsNew = useWhatsNewStore()
const tour = useTourStore()

useShortcuts()

watch(
  () => settings.themeName,
  (name) => theme.change(name),
  { immediate: true }
)

let unsubscribe: (() => void) | null = null
let cancelUpdateCheck: (() => void) | null = null
let unmounted = false

/** The screenshot harness triggers the update check, «novedades» and tours itself (they would cover other screens). */
const screenshotMode = new URLSearchParams(window.location.search).get('nd-screenshots') === '1'

onMounted(() => {
  unsubscribe = subscribeToMainEvents()
  // The automatic update check waits for the settings (its switch) and a few seconds more.
  void loadInitialData().then(async () => {
    if (unmounted || screenshotMode) return
    // First run of a fresh profile: the welcome tour (it ends offering the Navicat import).
    // Profiles updated from an older build get the «novedades» popup instead.
    await tour.maybeStartWelcome()
    if (unmounted) return
    void whatsNew.load()
    cancelUpdateCheck = updates.scheduleStartupCheck()
  })
})

onBeforeUnmount(() => {
  unmounted = true
  unsubscribe?.()
  cancelUpdateCheck?.()
})
</script>

<template>
  <v-app class="vortaq">
    <div class="shell">
      <AppToolbar />
      <div class="shell__main">
        <div class="shell__tree" :style="{ width: `${ui.treeWidth}px` }">
          <ConnectionTree />
        </div>
        <PaneSplitter
          v-model="ui.treeWidth"
          side="left"
          :min="180"
          :max="520"
          label="Redimensionar Mis Conexiones"
        />
        <main class="shell__center">
          <WorkspaceTabs />
        </main>
        <template v-if="ui.infoPanelVisible">
          <PaneSplitter
            v-model="ui.infoWidth"
            side="right"
            :min="220"
            :max="480"
            label="Redimensionar panel de información"
          />
          <div class="shell__info" :style="{ width: `${ui.infoWidth}px` }">
            <InfoPanel />
          </div>
        </template>
        <template v-else-if="ui.aiPanelVisible">
          <PaneSplitter
            v-model="ui.aiWidth"
            side="right"
            :min="320"
            :max="720"
            label="Redimensionar panel del asistente"
          />
          <div class="shell__info" :style="{ width: `${ui.aiWidth}px` }">
            <AiPanel />
          </div>
        </template>
      </div>
      <LogDrawer />
      <StatusBar />
    </div>

    <ProgressOverlay />
    <ConfirmHost />
    <NotifyHost />

    <ConnectionDialog />
    <ImportWizard />
    <ImportNavicatDialog />
    <SettingsDialog />
    <AboutDialog />
    <NewDatabaseDialog />
    <BackupDialog />
    <RestoreDialog />
    <UpdateDialog />
    <UpdateNotice />
    <WhatsNewDialog />
    <TourHost />
  </v-app>
</template>

<style>
/* The shell owns all scrolling; beats Vuetify's `html { overflow-y: scroll }` gutter. */
html,
body,
#app {
  height: 100%;
  overflow: hidden !important;
}

/*
 * Shell disabled foreground: secondary text at reduced alpha, tuned per theme to
 * stay around 3:1 against the panels ("clearly dimmed but legible"). Icon and
 * label share it so a disabled action reads as one dimmed unit.
 */
:root,
.v-theme--vortaqDark {
  --nd-shell-disabled: color-mix(in srgb, var(--nd-text-2) 64%, transparent);
}
.v-theme--vortaqLight {
  --nd-shell-disabled: color-mix(in srgb, var(--nd-text-2) 70%, transparent);
}
</style>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-height: 0;
  background: var(--nd-bg-app);
}
.shell__main {
  display: flex;
  flex: 1;
  min-height: 0;
  padding: 0 8px 8px;
}
/* Every pane is a rounded panel floating on the app background. */
.shell__tree,
.shell__info,
.shell__center {
  min-height: 0;
  overflow: hidden;
  background: var(--nd-bg-panel);
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-card);
  box-shadow: var(--nd-shadow-inset);
}
.shell__tree,
.shell__info {
  flex: none;
}
.shell__center {
  flex: 1;
  min-width: 0;
}
</style>
