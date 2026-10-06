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
import StatusBar from '@renderer/components/layout/StatusBar.vue'
import ProgressOverlay from '@renderer/components/layout/ProgressOverlay.vue'
import LogDrawer from '@renderer/components/layout/LogDrawer.vue'
import PaneSplitter from '@renderer/components/layout/PaneSplitter.vue'
import ConfirmHost from '@renderer/components/common/ConfirmHost.vue'
import NotifyHost from '@renderer/components/common/NotifyHost.vue'
import ConnectionDialog from '@renderer/components/dialogs/ConnectionDialog.vue'
import ImportNavicatDialog from '@renderer/components/dialogs/ImportNavicatDialog.vue'
import SettingsDialog from '@renderer/components/dialogs/SettingsDialog.vue'
import NewDatabaseDialog from '@renderer/components/dialogs/NewDatabaseDialog.vue'
import BackupDialog from '@renderer/components/dialogs/BackupDialog.vue'
import RestoreDialog from '@renderer/components/dialogs/RestoreDialog.vue'

const ui = useUiStore()
const settings = useSettingsStore()
const theme = useTheme()

useShortcuts()

watch(
  () => settings.themeName,
  (name) => theme.change(name),
  { immediate: true }
)

let unsubscribe: (() => void) | null = null

onMounted(() => {
  unsubscribe = subscribeToMainEvents()
  void loadInitialData()
})

onBeforeUnmount(() => unsubscribe?.())
</script>

<template>
  <v-app class="electrondb">
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
      </div>
      <LogDrawer />
      <StatusBar />
    </div>

    <ProgressOverlay />
    <ConfirmHost />
    <NotifyHost />

    <ConnectionDialog />
    <ImportNavicatDialog />
    <SettingsDialog />
    <NewDatabaseDialog />
    <BackupDialog />
    <RestoreDialog />
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
.v-theme--electrondbDark {
  --nd-shell-disabled: color-mix(in srgb, var(--nd-text-2) 64%, transparent);
}
.v-theme--electrondbLight {
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
