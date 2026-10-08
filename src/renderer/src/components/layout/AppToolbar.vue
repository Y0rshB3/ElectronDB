<script setup lang="ts">
import { computed } from 'vue'
import { useWorkspace } from '@renderer/composables/useWorkspace'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useTreeStore } from '@renderer/stores/tree'
import { useTabsStore } from '@renderer/stores/tabs'
import { useUiStore } from '@renderer/stores/ui'
import { useUpdatesStore } from '@renderer/stores/updates'
import { useTourStore } from '@renderer/stores/tour'
import { useObjectsContext } from '@renderer/composables/useObjectsContext'
import { useNotify } from '@renderer/composables/useNotify'
import { runSafely } from '@renderer/utils/errors'
import { descriptorOf, groupsFor } from '@renderer/engines/capabilities'
import { pickableEngines } from '@shared/engines'
import { useSettingsStore } from '@renderer/stores/settings'

const ws = useWorkspace()
const tree = useTreeStore()
const connections = useConnectionsStore()
const ui = useUiStore()
const tabs = useTabsStore()
const updates = useUpdatesStore()
const tour = useTourStore()
const notify = useNotify()
const { context: objectsContext } = useObjectsContext()
const settingsStore = useSettingsStore()

/*
 * «Nueva conexión» entries: with Ajustes › Motores en vista previa off only
 * MySQL is offered (today's single entry); with it on, one entry per engine.
 */
const newConnectionItems = computed<ToolbarMenuItem[]>(() => {
  const engines = pickableEngines(settingsStore.settings.previewEngines === true)
  if (engines.length <= 1)
    return [
      {
        label: 'Nueva conexión MySQL…',
        icon: 'mdi-database-plus-outline',
        action: () => ui.openConnectionDialog(null)
      }
    ]
  return engines.map((e) => ({
    label: `Nueva conexión ${e.label}${e.capabilities.preview ? ' (vista previa)' : ''}…`,
    icon: e.icon,
    action: () => ui.openConnectionDialog(null, e.id)
  }))
})

const hasConnection = computed(() => !!ws.currentConnectionId())
const schemaContext = computed(() => {
  const sel = tree.selected
  return sel && sel.schema && connections.isOpen(sel.connectionId)
    ? { connectionId: sel.connectionId, schema: sel.schema }
    : null
})

/*
 * Capabilities of the connection the toolbar acts on. Without a connection the
 * descriptor is MySQL's; modules an engine lacks are left out of the dock and
 * of the Objetos menu.
 */
const caps = computed(() => {
  const id = ws.currentConnectionId()
  return descriptorOf(id ? connections.get(id) : undefined)?.capabilities ?? null
})
/** Tree groups of that connection's engine (SQLite lists indexes and triggers). */
const groups = computed(() => {
  const id = ws.currentConnectionId()
  return groupsFor(id ? connections.get(id) : undefined)
})

interface ToolbarMenuItem {
  label: string
  icon: string
  action: () => unknown
  /** Draws a divider above this entry (starts a new group inside the menu). */
  dividerBefore?: boolean
}

interface ToolbarAction {
  key: string
  label: string
  icon: string
  disabled?: boolean
  /** Draws a divider after this button to group related modules. */
  separatorAfter?: boolean
  /** Primary action; when absent the button itself opens the menu. */
  action?: () => unknown
  menu?: ToolbarMenuItem[]
}

function requireSchema(fn: (connectionId: string, schema: string) => void): () => void {
  return () => {
    const ctx = schemaContext.value
    if (!ctx) {
      notify.warning('Selecciona una base de datos en el árbol de conexiones')
      return
    }
    fn(ctx.connectionId, ctx.schema)
  }
}

/** Objetos ▾: browse each object group, then create objects in the selected database. */
const objectsMenu = computed<ToolbarMenuItem[]>(() => {
  const routines = !!caps.value?.routines
  const items: (ToolbarMenuItem | false)[] = [
    { label: 'Tablas', icon: 'mdi-table', action: () => ws.showGroup('tables') },
    { label: 'Vistas', icon: 'mdi-table-eye', action: () => ws.showGroup('views') },
    groups.value.includes('indexes') && {
      label: 'Índices',
      icon: 'mdi-sort-ascending',
      action: () => ws.showGroup('indexes')
    },
    groups.value.includes('triggers') && {
      label: 'Triggers',
      icon: 'mdi-flash-outline',
      action: () => ws.showGroup('triggers')
    },
    routines && {
      label: 'Funciones y procedimientos',
      icon: 'mdi-function-variant',
      action: () => ws.showGroup('functions')
    },
    !!caps.value?.events && {
      label: 'Eventos',
      icon: 'mdi-calendar-clock',
      action: () => ws.showGroup('events')
    },
    {
      label: 'Consultas guardadas',
      icon: 'mdi-database-search',
      action: () => ws.showGroup('queries')
    },
    {
      label: 'Nueva tabla',
      icon: 'mdi-table-plus',
      dividerBefore: true,
      action: requireSchema((c, s) => ws.openTableDesigner(c, s, null))
    },
    {
      label: 'Nueva vista',
      icon: 'mdi-plus',
      action: requireSchema((c, s) => ws.openDdlEditor(c, s, 'view', null))
    },
    routines && {
      label: 'Nueva función',
      icon: 'mdi-function-variant',
      action: requireSchema((c, s) => ws.openDdlEditor(c, s, 'function', null))
    },
    routines && {
      label: 'Nuevo procedimiento',
      icon: 'mdi-script-text-outline',
      action: requireSchema((c, s) => ws.openDdlEditor(c, s, 'procedure', null))
    }
  ]
  return items.filter((m): m is ToolbarMenuItem => !!m)
})

const actions = computed<ToolbarAction[]>(() => {
  const items: (ToolbarAction | false)[] = [
    {
      key: 'connection',
      label: 'Conexión',
      icon: 'mdi-database-plus-outline',
      action: () => ui.openConnectionDialog(null),
      menu: [
        ...newConnectionItems.value,
        { label: 'Importar…', icon: 'mdi-import', action: () => ui.openImportWizard() }
      ]
    },
    {
      key: 'query',
      label: 'Nueva consulta',
      icon: 'mdi-database-search-outline',
      disabled: !hasConnection.value,
      separatorAfter: true,
      action: () => ws.openQuery()
    },
    {
      key: 'objects',
      label: 'Objetos',
      icon: 'mdi-shape-outline',
      disabled: !hasConnection.value,
      separatorAfter: !caps.value?.hasUsers,
      menu: objectsMenu.value
    },
    !!caps.value?.hasUsers && {
      key: 'users',
      label: 'Usuarios',
      icon: 'mdi-account-multiple-outline',
      disabled: !hasConnection.value,
      separatorAfter: true,
      action: () => ws.openUsers()
    },
    !!(caps.value?.supportsBackupsNb3 || caps.value?.supportsBackupsVqb) && {
      key: 'backup',
      label: 'Copias de seguridad',
      icon: 'mdi-archive-outline',
      disabled: !hasConnection.value,
      action: () => ws.openBackups(ws.currentConnectionId(), tree.selected?.schema ?? null)
    },
    {
      key: 'automation',
      label: 'Automatización',
      icon: 'mdi-robot-outline',
      separatorAfter: true,
      action: () => ws.openAutomation()
    },
    {
      key: 'more',
      label: 'Más',
      icon: 'mdi-dots-horizontal-circle-outline',
      menu: [
        { label: 'Importar…', icon: 'mdi-import', action: () => ui.openImportWizard() },
        {
          label: 'Buscar actualizaciones…',
          icon: 'mdi-update',
          action: () => updates.openDialog()
        },
        {
          label: 'Ver tour de bienvenida',
          icon: 'mdi-map-marker-path',
          action: () => tour.startWelcome()
        },
        { label: 'Registro', icon: 'mdi-text-box-outline', action: () => ui.toggleLogDrawer(true) },
        {
          label: 'Ajustes…',
          icon: 'mdi-cog-outline',
          dividerBefore: true,
          action: () => ui.openSettingsDialog()
        },
        {
          label: 'Acerca de Vortaq',
          icon: 'mdi-information-outline',
          action: () => ui.openAboutDialog()
        }
      ]
    }
  ]
  return items.filter((a): a is ToolbarAction => !!a)
})

/** Toolbar module that matches what the active tab is showing (highlighted in the dock). */
const activeKey = computed<string | null>(() => {
  const tab = tabs.active
  switch (tab.kind) {
    case 'query':
      return 'query'
    case 'tableData':
    case 'tableDesigner':
    case 'ddlEditor':
      return 'objects'
    case 'users':
      return 'users'
    case 'backups':
      return 'backup'
    case 'automation':
    case 'jobEditor':
      return 'automation'
    case 'objects': {
      const group = objectsContext.value?.group
      if (!group) return null
      return group === 'backups' ? 'backup' : 'objects'
    }
    default:
      return null
  }
})
</script>

<template>
  <header class="app-toolbar" role="toolbar" aria-label="Barra de herramientas principal">
    <div class="app-toolbar__drag-space" aria-hidden="true" />
    <div class="app-toolbar__center">
      <nav class="app-toolbar__dock">
        <template v-for="item in actions" :key="item.key">
          <div
            class="app-toolbar__item"
            :data-tour="`toolbar-${item.key}`"
            :class="{
              'app-toolbar__item--active': activeKey === item.key,
              'app-toolbar__item--split': !!(item.action && item.menu),
              'app-toolbar__item--disabled': item.disabled
            }"
          >
            <v-menu v-if="!item.action && item.menu" location="bottom" offset="8">
              <template #activator="{ props: mp }">
                <v-btn
                  v-bind="mp"
                  :data-test="`toolbar-${item.key}`"
                  class="app-toolbar__btn"
                  variant="text"
                  stacked
                  size="small"
                  :disabled="item.disabled"
                  :aria-label="item.label"
                  :aria-current="activeKey === item.key ? 'true' : undefined"
                >
                  <v-icon :icon="item.icon" size="20" class="app-toolbar__icon" />
                  <span class="app-toolbar__label">{{ item.label }}</span>
                </v-btn>
              </template>
              <v-list density="compact" min-width="220">
                <template v-for="m in item.menu" :key="m.label">
                  <v-divider v-if="m.dividerBefore" class="my-1" />
                  <v-list-item
                    :prepend-icon="m.icon"
                    :title="m.label"
                    @click="runSafely(m.action)"
                  />
                </template>
              </v-list>
            </v-menu>
            <template v-else>
              <v-btn
                :data-test="`toolbar-${item.key}`"
                class="app-toolbar__btn"
                variant="text"
                stacked
                size="small"
                :disabled="item.disabled"
                :aria-label="item.label"
                :aria-current="activeKey === item.key ? 'true' : undefined"
                @click="runSafely(item.action)"
              >
                <v-icon :icon="item.icon" size="20" class="app-toolbar__icon" />
                <span class="app-toolbar__label">{{ item.label }}</span>
              </v-btn>
              <v-menu v-if="item.menu" location="bottom" offset="8">
                <template #activator="{ props: mp }">
                  <v-btn
                    v-bind="mp"
                    variant="text"
                    class="app-toolbar__caret"
                    :disabled="item.disabled"
                    :aria-label="`Opciones de ${item.label}`"
                  >
                    <v-icon icon="mdi-chevron-down" size="14" />
                  </v-btn>
                </template>
                <v-list density="compact" min-width="220">
                  <template v-for="m in item.menu" :key="m.label">
                    <v-divider v-if="m.dividerBefore" class="my-1" />
                    <v-list-item
                      :prepend-icon="m.icon"
                      :title="m.label"
                      @click="runSafely(m.action)"
                    />
                  </template>
                </v-list>
              </v-menu>
            </template>
          </div>
          <span v-if="item.separatorAfter" class="app-toolbar__sep" aria-hidden="true" />
        </template>
      </nav>
    </div>
    <div class="app-toolbar__right">
      <v-btn
        icon="mdi-creation-outline"
        variant="text"
        size="small"
        class="app-toolbar__settings app-toolbar__ai"
        :class="{ 'app-toolbar__ai--on': ui.aiPanelVisible }"
        aria-label="Asistente de IA"
        title="Asistente de IA"
        :aria-pressed="ui.aiPanelVisible"
        data-test="toolbar-ai"
        data-tour="toolbar-ai"
        @click="ui.toggleAiPanel()"
      />
      <v-btn
        icon="mdi-cog-outline"
        variant="text"
        size="small"
        class="app-toolbar__settings"
        aria-label="Preferencias"
        title="Preferencias"
        data-test="toolbar-settings"
        data-tour="toolbar-settings"
        @click="ui.openSettingsDialog()"
      />
    </div>
  </header>
</template>

<style scoped>
.app-toolbar {
  display: grid;
  grid-template-columns: var(--nd-drag-region) minmax(0, 1fr) auto;
  align-items: center;
  flex: none;
  height: var(--nd-toolbar-h);
  /* right: room for the Windows/Linux window controls overlay (0 on macOS) */
  padding: 0 calc(12px + var(--nd-window-controls)) 0 0;
  background: transparent;
  -webkit-app-region: drag;
  user-select: none;
}
.app-toolbar__drag-space {
  height: 100%;
}
.app-toolbar__center {
  display: flex;
  justify-content: center;
  min-width: 0;
  overflow: hidden;
  padding: 0 8px;
}
/* Floating glass dock (a pill) holding the module buttons. */
.app-toolbar__dock {
  display: flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  padding: 4px 6px;
  border-radius: 16px;
  background: var(--nd-glass);
  -webkit-backdrop-filter: var(--nd-glass-blur);
  backdrop-filter: var(--nd-glass-blur);
  border: 1px solid var(--nd-border);
  box-shadow: var(--nd-shadow-1), var(--nd-shadow-inset);
  -webkit-app-region: no-drag;
}
.app-toolbar__dock::-webkit-scrollbar {
  display: none;
}
.app-toolbar__sep {
  flex: none;
  width: 1px;
  height: 28px;
  margin: 0 4px;
  background: var(--nd-border);
}
.app-toolbar__item {
  position: relative;
  display: flex;
  align-items: stretch;
  flex: none;
  border-radius: 10px;
  transition:
    background-color var(--nd-dur) var(--nd-ease),
    transform var(--nd-dur) var(--nd-ease);
}
.app-toolbar__item:not(.app-toolbar__item--disabled):hover {
  background: var(--nd-hover);
  transform: translateY(-1px);
}
.app-toolbar__btn.v-btn {
  height: 46px !important;
  min-width: 62px;
  padding: 0 8px;
  border-radius: 10px;
  color: var(--nd-text-2);
}
.app-toolbar__btn.v-btn:hover {
  color: var(--nd-text);
}
.app-toolbar__btn.v-btn :deep(.v-btn__overlay) {
  opacity: 0 !important;
}
.app-toolbar__btn.v-btn :deep(.v-btn__content) {
  gap: 3px;
}
.app-toolbar__item--split .app-toolbar__btn.v-btn {
  padding-right: 2px;
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.app-toolbar__icon {
  transition:
    color var(--nd-dur) var(--nd-ease),
    filter var(--nd-dur) var(--nd-ease);
}
.app-toolbar__label {
  font-size: var(--nd-fs-xs);
  font-weight: 500;
  line-height: 1.1;
  white-space: nowrap;
}
.app-toolbar__caret.v-btn {
  width: 16px;
  min-width: 16px;
  height: 46px !important;
  padding: 0;
  margin-left: -2px;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  color: var(--nd-text-muted);
}
.app-toolbar__caret.v-btn:hover {
  color: var(--nd-text);
}
.app-toolbar__caret.v-btn :deep(.v-btn__overlay) {
  opacity: 0 !important;
}
.app-toolbar__caret.v-btn :deep(.v-btn__content) {
  margin-top: -14px;
}

/* Active module: raised glass, gradient glyph and a glowing gradient underline. */
.app-toolbar__item--active {
  background: var(--nd-accent-gradient-soft);
  box-shadow: inset 0 0 0 1px rgba(var(--nd-accent-rgb), 0.18);
}
.app-toolbar__item--active .app-toolbar__btn.v-btn {
  color: var(--nd-text);
}
.app-toolbar__item--active .app-toolbar__icon {
  background: var(--nd-accent-gradient);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
}
.app-toolbar__item--active::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 1px;
  width: 22px;
  height: 2px;
  margin-left: -11px;
  border-radius: 2px;
  background: var(--nd-accent-gradient-h);
  box-shadow: 0 0 10px rgba(var(--nd-accent-rgb), 0.6);
}

/* Disabled modules: dimmed but still legible. */
.app-toolbar__item--disabled .app-toolbar__btn.v-btn,
.app-toolbar__item--disabled .app-toolbar__caret.v-btn {
  color: var(--nd-shell-disabled) !important;
  background: transparent !important;
}
.app-toolbar__item--disabled .v-icon {
  opacity: 1;
}

.app-toolbar__right {
  display: flex;
  align-items: center;
  -webkit-app-region: no-drag;
}
.app-toolbar__settings.v-btn {
  width: 38px;
  height: 38px;
  border-radius: 12px;
  color: var(--nd-text-2);
  background: var(--nd-glass);
  border: 1px solid var(--nd-border);
}
.app-toolbar__settings.v-btn:hover {
  color: var(--nd-text);
  box-shadow: var(--nd-glow);
}
.app-toolbar__ai.v-btn {
  margin-right: 6px;
}
.app-toolbar__ai--on.v-btn {
  color: var(--nd-accent);
  background: var(--nd-accent-gradient-soft);
  border-color: rgba(var(--nd-accent-rgb), 0.3);
}
</style>
