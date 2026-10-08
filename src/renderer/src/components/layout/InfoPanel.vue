<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api } from '@renderer/api'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useTreeStore } from '@renderer/stores/tree'
import { useUiStore } from '@renderer/stores/ui'
import { engineObjectTypeOf, nameRefOf } from '@renderer/composables/useObjectActions'
import { schemaRef } from '@renderer/utils/schemaRef'
import { errorMessage } from '@renderer/composables/useNotify'
import { itemLabel, itemName, objectDetails, type DetailRow } from '@renderer/utils/objectColumns'
import { ENVIRONMENT_LABELS, GROUP_ICONS, GROUP_LABELS } from '@renderer/utils/objectTypes'
import { formatUptime } from '@renderer/utils/format'
import { descriptorOf } from '@renderer/engines/capabilities'
import EmptyState from '@renderer/components/common/EmptyState.vue'

const tree = useTreeStore()
const connections = useConnectionsStore()
const ui = useUiStore()

const node = computed(() => tree.selected)
const connection = computed(() =>
  node.value ? connections.get(node.value.connectionId) : undefined
)
const server = computed(() =>
  node.value ? connections.serverInfo[node.value.connectionId] : undefined
)
const isOpen = computed(() => (node.value ? connections.isOpen(node.value.connectionId) : false))

const connectionRows = computed<DetailRow[]>(() => {
  const c = connection.value
  if (!c) return []
  const s = server.value
  const dash = (v: string | number | null | undefined): string =>
    v === null || v === undefined || v === '' ? '—' : String(v)
  const sourceApp: Record<string, string> = {
    navicat: 'Navicat',
    dbeaver: 'DBeaver',
    workbench: 'MySQL Workbench'
  }
  const notes = c.source
    ? `Importada de ${sourceApp[c.source.app] ?? c.source.app} (${c.source.name})`
    : ''
  // SQLite: a file, no server (host, port, user and uptime do not apply).
  const hasServer = descriptorOf(c)?.capabilities.needsHost !== false
  return [
    { label: 'Perfil activo', value: ENVIRONMENT_LABELS[c.environment] ?? c.environment },
    {
      label: 'Versión del servidor',
      value: s
        ? `${s.version}${s.versionComment ? ` (${s.versionComment})` : ''}`
        : isOpen.value
          ? '—'
          : 'Conexión cerrada'
    },
    ...(hasServer
      ? [
          { label: 'Host', value: dash(c.host) },
          { label: 'Puerto', value: dash(c.port) },
          { label: 'Nombre de usuario', value: dash(c.username) }
        ]
      : []),
    { label: 'Codificación', value: dash(s?.characterSet) },
    ...(c.ssh.enabled
      ? [{ label: 'Túnel SSH', value: `${c.ssh.username}@${c.ssh.host}:${c.ssh.port}` }]
      : []),
    ...(s && hasServer
      ? [{ label: 'Tiempo activo', value: dash(formatUptime(s.uptimeSeconds)) }]
      : []),
    // Engine-neutral facts (PostgreSQL: initial database, session time zone, TLS…); MySQL sends none.
    ...(s?.details ?? []).map((d) => ({ label: d.label, value: dash(d.value) })),
    { label: 'Observaciones', value: dash(notes) }
  ]
})

/** Values shown in monospace (hosts, ports, versions, counts). */
const MONO_LABELS = new Set([
  'Host',
  'Puerto',
  'Versión del servidor',
  'Túnel SSH',
  'Tiempo activo',
  'Filas',
  'Longitud de datos',
  'Longitud de índice',
  'Auto incremento',
  'Fecha de creación',
  'Fecha de modificación'
])
const isMono = (label: string): boolean => MONO_LABELS.has(label)

const ENV_PILL: Record<string, string> = {
  production: 'nd-pill--production',
  staging: 'nd-pill--staging',
  local: 'nd-pill--local'
}

/** Selected object (object node) resolved against the cached group items. */
const objectInfo = computed(() => {
  const n = node.value
  if (!n || n.kind !== 'object' || !n.schema || !n.group || !n.name) return null
  const item = tree
    .itemsOf(n.connectionId, n.schema, n.group, n.database)
    .find((i) => itemName(n.group!, i) === n.name)
  if (!item) return null
  return {
    title: itemLabel(n.group, item) || n.label,
    icon: GROUP_ICONS[n.group],
    subtitle: `${GROUP_LABELS[n.group]} · ${n.database !== undefined ? `${n.database}.${n.schema}` : n.schema}`,
    rows: objectDetails(n.group, item, connections.get(n.connectionId)?.engine)
  }
})

const schemaInfo = computed(() => {
  const n = node.value
  if (n?.kind === 'database' && n.database !== undefined) {
    const db = (tree.databases[n.connectionId] ?? []).find((d) => d.name === n.database)
    return {
      title: n.database,
      rows: [
        { label: 'Codificación', value: db?.characterSet || '—' },
        { label: 'Intercalación', value: db?.collation || '—' }
      ]
    }
  }
  if (!n || (n.kind !== 'schema' && n.kind !== 'group') || !n.schema) return null
  if (n.database !== undefined) {
    // PostgreSQL schema: owner and comment instead of MySQL's charset/collation.
    const info = tree.schemasOf(n.connectionId, n.database).find((x) => x.name === n.schema)
    return {
      title: n.schema,
      subtitle: `Esquema · ${n.database}`,
      rows: [
        { label: 'Propietario', value: info?.owner || '—' },
        { label: 'Comentario', value: info?.comment || '—' }
      ]
    }
  }
  const config = connections.get(n.connectionId)
  if (config?.engine === 'sqlite') {
    // SQLite: main is the connection's file, the others are attachments (or temp).
    const file =
      n.schema === 'main'
        ? config.sqlite?.filePath
        : n.schema === 'temp'
          ? 'Temporal (en memoria)'
          : config.sqlite?.attached.find((a) => a.alias === n.schema)?.filePath ||
            'Adjuntada desde el editor (esta sesión)'
    return {
      title: n.schema,
      subtitle: n.schema === 'main' ? 'Base de datos principal' : 'Base de datos adjunta',
      rows: [{ label: 'Archivo', value: file || '—' }]
    }
  }
  if (config?.engine === 'mongodb') {
    const collections = tree.itemsOf(n.connectionId, n.schema, 'collections')
    return {
      title: n.schema,
      subtitle: 'Base de datos MongoDB',
      rows: [
        {
          label: 'Colecciones',
          value: tree.hasItems(n.connectionId, n.schema, 'collections')
            ? String(collections.length)
            : '—'
        }
      ]
    }
  }
  const db = (tree.databases[n.connectionId] ?? []).find((d) => d.name === n.schema)
  return {
    title: n.schema,
    rows: [
      { label: 'Juego de caracteres', value: db?.characterSet || '—' },
      { label: 'Intercalación', value: db?.collation || '—' }
    ]
  }
})

/* ---------- DDL preview (loaded on demand, cached per node) ---------- */

const view = ref<'general' | 'ddl'>('general')
const ddlCache = ref<Record<string, string>>({})
const ddlLoading = ref(false)
const ddlError = ref<string | null>(null)

// MongoDB objects have no DDL text (their structure is in the collection designer).
const ddlType = computed(() =>
  node.value &&
  node.value.kind === 'object' &&
  connections.get(node.value.connectionId)?.engine !== 'mongodb'
    ? engineObjectTypeOf(node.value)
    : null
)
const ddl = computed(() => (node.value ? ddlCache.value[node.value.id] : undefined))

async function loadDdl(): Promise<void> {
  const n = node.value
  const type = ddlType.value
  if (!n || !type || !n.schema || !n.name || ddlCache.value[n.id] !== undefined) return
  ddlLoading.value = true
  ddlError.value = null
  try {
    const sql = await api.invokeSilent(
      'db:showCreate',
      n.connectionId,
      schemaRef(n.schema, n.database),
      type,
      nameRefOf(n, type)
    )
    ddlCache.value = { ...ddlCache.value, [n.id]: sql }
  } catch (err) {
    ddlError.value = errorMessage(err)
  } finally {
    ddlLoading.value = false
  }
}

watch([view, () => node.value?.id], () => {
  ddlError.value = null
  if (view.value === 'ddl') void loadDdl()
})
watch(ddlType, (type) => {
  if (!type) view.value = 'general'
})
</script>

<template>
  <aside class="info-panel" aria-label="Información">
    <div class="info-panel__header">
      <v-btn-toggle
        v-if="ddlType"
        v-model="view"
        mandatory
        density="compact"
        variant="text"
        class="info-panel__switch"
        aria-label="Vista del panel"
      >
        <v-btn value="general" size="x-small">General</v-btn>
        <v-btn value="ddl" size="x-small" data-test="info-ddl">DDL</v-btn>
      </v-btn-toggle>
      <span v-else class="info-panel__heading">Información</span>
      <v-spacer />
      <v-btn
        icon="mdi-dock-right"
        size="x-small"
        variant="text"
        class="info-panel__hide"
        aria-label="Ocultar panel de información"
        title="Ocultar panel"
        @click="ui.toggleInfoPanel(false)"
      />
    </div>

    <div class="info-panel__body">
      <EmptyState
        v-if="!connection"
        size="compact"
        icon="mdi-information-variant"
        title="Sin selección"
        description="Selecciona una conexión u objeto para ver su información."
      />

      <template v-else-if="view === 'ddl' && ddlType">
        <v-progress-linear v-if="ddlLoading" indeterminate height="2" />
        <div v-if="ddlError" class="info-panel__error">{{ ddlError }}</div>
        <pre v-else-if="ddl !== undefined" class="info-panel__ddl" data-test="info-ddl-text">{{
          ddl
        }}</pre>
      </template>

      <template v-else>
        <section v-if="objectInfo" class="info-panel__section" data-test="info-object">
          <div class="info-panel__title">
            <span class="info-panel__badge" aria-hidden="true">
              <v-icon :icon="objectInfo.icon" size="16" />
            </span>
            <div class="info-panel__titles">
              <div class="info-panel__name" :title="objectInfo.title">{{ objectInfo.title }}</div>
              <div class="info-panel__sub">{{ objectInfo.subtitle }}</div>
            </div>
          </div>
          <dl class="info-panel__list">
            <template v-for="r in objectInfo.rows" :key="r.label">
              <dt>{{ r.label }}</dt>
              <dd :class="{ 'nd-mono': isMono(r.label) }" :title="r.value">{{ r.value }}</dd>
            </template>
          </dl>
        </section>

        <section v-else-if="schemaInfo" class="info-panel__section">
          <div class="info-panel__title">
            <span class="info-panel__badge" aria-hidden="true">
              <v-icon icon="mdi-database-outline" size="16" />
            </span>
            <div class="info-panel__titles">
              <div class="info-panel__name" :title="schemaInfo.title">{{ schemaInfo.title }}</div>
              <div class="info-panel__sub">
                {{ 'subtitle' in schemaInfo ? schemaInfo.subtitle : 'Base de datos' }}
              </div>
            </div>
          </div>
          <dl class="info-panel__list">
            <template v-for="r in schemaInfo.rows" :key="r.label">
              <dt>{{ r.label }}</dt>
              <dd class="nd-mono" :title="r.value">{{ r.value }}</dd>
            </template>
          </dl>
        </section>

        <section class="info-panel__section" data-test="info-connection">
          <div class="info-panel__title">
            <span
              class="info-panel__swatch"
              :class="{
                'info-panel__swatch--none': !connection.color,
                'info-panel__swatch--live': isOpen
              }"
              :style="{
                background: connection.color ?? 'transparent',
                '--nd-dot': connection.color ?? 'transparent'
              }"
              aria-hidden="true"
            />
            <div class="info-panel__titles">
              <div class="info-panel__name" :title="connection.name">{{ connection.name }}</div>
              <div class="info-panel__status" :class="{ 'info-panel__status--on': isOpen }">
                {{ isOpen ? 'Conectado' : 'Desconectado' }}
              </div>
            </div>
            <span class="nd-pill info-panel__env" :class="ENV_PILL[connection.environment]">{{
              ENVIRONMENT_LABELS[connection.environment]
            }}</span>
          </div>
          <dl class="info-panel__list">
            <template v-for="r in connectionRows" :key="r.label">
              <dt>{{ r.label }}</dt>
              <dd :class="{ 'nd-mono': isMono(r.label) }" :title="r.value">{{ r.value }}</dd>
            </template>
          </dl>
        </section>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.info-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: transparent;
}
.info-panel__header {
  display: flex;
  align-items: center;
  height: 42px;
  padding: 0 6px 0 14px;
  border-bottom: 1px solid var(--nd-hairline);
  flex: none;
}
.info-panel__heading {
  font-size: var(--nd-fs-dense);
  font-weight: 600;
  color: var(--nd-text);
}
.info-panel__switch :deep(.v-btn) {
  height: 24px !important;
  padding: 0 10px;
  font-size: var(--nd-fs-xs);
}
.info-panel__hide.v-btn {
  color: var(--nd-text-muted);
}
.info-panel__hide.v-btn:hover {
  color: var(--nd-text);
}
.info-panel__body {
  flex: 1;
  overflow: auto;
  padding: 8px;
}
.info-panel__error {
  padding: 10px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-error);
}
/* Each block is a soft raised card inside the panel. */
.info-panel__section {
  padding: 12px 12px 8px;
  margin-bottom: 8px;
  border-radius: 10px;
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-border);
  box-shadow: var(--nd-shadow-inset);
}
.info-panel__title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.info-panel__titles {
  flex: 1;
  min-width: 0;
}
.info-panel__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  color: var(--nd-accent);
  background: var(--nd-accent-gradient-soft);
  border: 1px solid rgba(var(--nd-accent-rgb), 0.22);
}
.info-panel__name {
  font-weight: 600;
  font-size: var(--nd-fs-base);
  color: var(--nd-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.info-panel__sub {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.info-panel__swatch {
  width: 10px;
  height: 10px;
  margin: 0 10px 0 10px;
  border-radius: 50%;
  flex: none;
}
.info-panel__swatch--live {
  box-shadow: 0 0 10px var(--nd-dot);
}
.info-panel__swatch--none {
  box-shadow: inset 0 0 0 1.5px var(--nd-text-muted);
}
.info-panel__status {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.info-panel__status::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.info-panel__status--on {
  color: var(--nd-success);
}
.info-panel__status--on::before {
  box-shadow: 0 0 6px currentColor;
}
.info-panel__env {
  flex: none;
}
.info-panel__list {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  font-size: var(--nd-fs-dense);
  margin: 0;
}
.info-panel__list dt,
.info-panel__list dd {
  padding: 6px 0;
  border-top: 1px solid var(--nd-hairline);
}
.info-panel__list dt {
  color: var(--nd-text-2);
  white-space: nowrap;
  padding-right: 12px;
}
.info-panel__list dd {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: end;
  color: var(--nd-text);
}
.info-panel__list dd.nd-mono {
  font-size: var(--nd-fs-xs);
  line-height: 18px;
}
.info-panel__ddl {
  margin: 0;
  padding: 12px;
  border-radius: 10px;
  background: var(--nd-bg-sunken);
  border: 1px solid var(--nd-border);
  color: var(--nd-text);
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
</style>
