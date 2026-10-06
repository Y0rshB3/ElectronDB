<script setup lang="ts">
import {
  computed,
  onActivated,
  onDeactivated,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
  watch
} from 'vue'
import type { QueryStatementResult } from '@shared/types'
import { api } from '@renderer/api'
import SqlEditor from '@renderer/components/common/SqlEditor.vue'
import { cached, type SchemaProvider } from '@renderer/components/common/editor/sqlCompletion'
import { invokeSilent } from '@renderer/api'
import EditableResult from '@renderer/components/query/EditableResult.vue'
import QueryConnectionPicker from '@renderer/components/query/QueryConnectionPicker.vue'
import QueryMessages from '@renderer/components/query/QueryMessages.vue'
import { beautifySql } from '@renderer/components/query/beautifySql'
import {
  analyzeDestructiveScript,
  destructiveItems,
  destructiveTitle
} from '@renderer/components/query/destructiveGuard'
import { analyzeWrites } from '@renderer/components/query/writeGuard'
import { typedTarget, useConfirm } from '@renderer/composables/useConfirm'
import { useWorkspace } from '@renderer/composables/useWorkspace'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useQueriesStore } from '@renderer/stores/queries'
import { useSettingsStore } from '@renderer/stores/settings'
import { useTabsStore, type WorkspaceTab } from '@renderer/stores/tabs'
import { formatDuration } from '@renderer/utils/format'
import AiGenerateSqlDialog from '@renderer/components/ai/AiGenerateSqlDialog.vue'
import { registerQueryEditor } from '@renderer/composables/useQueryEditors'
import { useAiStore } from '@renderer/stores/ai'

const props = defineProps<{ tab: WorkspaceTab }>()

const tabs = useTabsStore()
const queries = useQueriesStore()
const connections = useConnectionsStore()
const settings = useSettingsStore()
const notify = useNotify()
const { ask, confirmDestructive } = useConfirm()
const workspace = useWorkspace()
const ai = useAiStore()

const editor = ref<InstanceType<typeof SqlEditor> | null>(null)
const sql = ref('')
const savedSql = ref('')
const savedQueryId = ref<string | null>(null)
/** Connection the saved query belongs to (queries are stored per connection). */
const savedConnectionId = ref<string | null>(null)
const queryName = ref('Consulta sin título')
const schema = ref<string | null>(props.tab.schema ?? null)
const schemas = ref<string[]>([])
/**
 * Lazy metadata for autocompletion, cached per connection: recreated when the
 * connection changes and cleared after running anything that may write.
 */
function makeProvider(): SchemaProvider & { clear(): void } {
  return cached({
    defaultSchema: () => schema.value || null,
    databases: async () =>
      connectionId.value
        ? (await invokeSilent('db:databases', connectionId.value)).map((d) => d.name)
        : [],
    tables: async (s) => {
      if (!connectionId.value) return []
      const [tables, views] = await Promise.all([
        invokeSilent('db:tables', connectionId.value, s),
        invokeSilent('db:views', connectionId.value, s).catch(() => [])
      ])
      return [
        ...tables.map((t) => ({ name: t.name, kind: 'table' as const })),
        ...views.map((v) => ({ name: v.name, kind: 'view' as const }))
      ]
    },
    columns: async (s, t) =>
      connectionId.value && s
        ? (await invokeSilent('db:columns', connectionId.value, s, t)).map((c) => ({
            name: c.name,
            type: c.columnType
          }))
        : []
  })
}
const completion = shallowRef(makeProvider())

const running = ref(false)
const results = ref<QueryStatementResult[]>([])
const notice = ref<string | null>(null)
const resultTab = ref('messages')
const totalMs = ref<number | null>(null)
let runSeq = 0
/** Bumped per run so every result set mounts a fresh EditableResult. */
const runId = ref(0)
/** Result set keys whose grid holds unapplied row edits. */
const pendingEdits = ref<Record<string, boolean>>({})

const saveDialog = ref(false)
const saveName = ref('')

/* Editor / results split, as a percentage of the body height (layout only). */
const body = ref<HTMLElement | null>(null)
const editorPct = ref(42)
const resizing = ref(false)
const SPLIT_MIN = 15
const SPLIT_MAX = 85

function setSplit(pct: number): void {
  editorPct.value = Math.round(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, pct)))
}

function startResize(event: PointerEvent): void {
  const el = body.value
  if (!el) return
  event.preventDefault()
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture?.(event.pointerId)
  resizing.value = true
  const onMove = (e: PointerEvent): void => {
    const rect = el.getBoundingClientRect()
    if (rect.height > 0) setSplit(((e.clientY - rect.top) / rect.height) * 100)
  }
  const onUp = (): void => {
    resizing.value = false
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.removeEventListener('pointercancel', onUp)
  }
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
  handle.addEventListener('pointercancel', onUp)
}

function onSplitKey(event: KeyboardEvent): void {
  const step = event.shiftKey ? 10 : 4
  if (event.key === 'ArrowUp') setSplit(editorPct.value - step)
  else if (event.key === 'ArrowDown') setSplit(editorPct.value + step)
  else if (event.key === 'Home') setSplit(SPLIT_MIN)
  else if (event.key === 'End') setSplit(SPLIT_MAX)
  else return
  event.preventDefault()
}

const connectionId = computed(() => props.tab.connectionId ?? '')
const production = computed(() => connections.isProduction(connectionId.value))
/** Switching connection (opening it, loading its databases). */
const switching = ref(false)
/** The saved query was opened on another connection: the next save stores it on this one. */
const savedElsewhere = computed(
  () =>
    !!savedQueryId.value &&
    !!savedConnectionId.value &&
    savedConnectionId.value !== connectionId.value
)
const saveTitle = computed(() =>
  savedElsewhere.value
    ? `Guardar (Cmd+S): la consulta se guardará en «${connections.nameOf(connectionId.value)}». La original de «${connections.nameOf(savedConnectionId.value ?? '')}» no cambia.`
    : 'Guardar (Cmd+S)'
)
const connectionLockReason = computed(() => {
  if (running.value) return 'Detén la consulta en curso para cambiar de conexión'
  if (switching.value) return 'Cambiando de conexión…'
  return null
})
const resultSets = computed(() =>
  results.value
    .map((r, index) => ({ r, index }))
    .filter((x) => x.r.resultSet)
    .map((x, n) => ({
      key: `rs${x.index}`,
      label: `Resultado ${n + 1}`,
      sql: x.r.sql,
      set: x.r.resultSet!
    }))
)
const errorCount = computed(() => results.value.filter((r) => r.error).length)
const sqlDirty = computed(() => sql.value !== savedSql.value || savedElsewhere.value)
const hasPendingEdits = computed(() => Object.values(pendingEdits.value).some(Boolean))
// The tab close guard asks while the SQL is unsaved or a result holds unapplied edits.
const dirty = computed(() => sqlDirty.value || hasPendingEdits.value)

watch(dirty, (value) => tabs.setDirty(props.tab.id, value), { immediate: true })

function setPendingEdits(key: string, value: boolean): void {
  pendingEdits.value = { ...pendingEdits.value, [key]: value }
}

/** Running again replaces the results: unapplied row edits would be lost. */
async function confirmDiscardEdits(): Promise<boolean> {
  if (!hasPendingEdits.value) return true
  return ask({
    title: 'Cambios sin aplicar',
    message:
      'Hay cambios sin aplicar en los resultados. Si vuelves a ejecutar la consulta se descartarán.',
    confirmText: 'Descartar y ejecutar',
    color: 'warning'
  })
}

function updateTitle(): void {
  const s = schema.value ? `@${schema.value}` : ''
  tabs.setTitle(props.tab.id, `${queryName.value}${s} (${connections.nameOf(connectionId.value)})`)
}

async function loadSchemas(): Promise<void> {
  if (!connectionId.value) return
  try {
    schemas.value = (await api.db.databases(connectionId.value)).map((d) => d.name)
  } catch {
    schemas.value = schema.value ? [schema.value] : []
  }
}

async function loadCompletion(): Promise<void> {
  // Warm the cache for the selected database so the first suggestions are instant.
  if (connectionId.value && schema.value) void completion.value.tables(schema.value).catch(() => [])
}

watch(schema, () => {
  updateTitle()
  void loadCompletion()
})

function loadPayload(): void {
  const payload = props.tab.payload ?? {}
  const id = typeof payload.savedQueryId === 'string' ? payload.savedQueryId : null
  if (id && connectionId.value) {
    const saved = queries.get(connectionId.value, id)
    if (saved) {
      savedQueryId.value = saved.id
      savedConnectionId.value = connectionId.value
      queryName.value = saved.name
      sql.value = saved.sql
      savedSql.value = saved.sql
      if (saved.schema) schema.value = saved.schema
      return
    }
    notify.warning('No se encontró la consulta guardada')
  }
  if (typeof payload.name === 'string' && payload.name) queryName.value = payload.name
  if (typeof payload.sql === 'string') sql.value = payload.sql
}

async function run(selectionOnly = false): Promise<void> {
  if (running.value || switching.value || !connectionId.value) return
  const selection = editor.value?.getSelection() ?? ''
  const script = (selectionOnly ? selection : selection || sql.value).trim()
  if (!script) {
    notify.warning('No hay SQL para ejecutar')
    return
  }
  if (!(await confirmDiscardEdits())) return
  // Allowlist: on production (and the environments of Ajustes › Seguridad) anything not provably
  // read-only (SELECT/SHOW/DESCRIBE/EXPLAIN/USE...) asks for the typed name first.
  const check = analyzeWrites(script)
  const confirmProduction = connections.needsTypedConfirm(connectionId.value) && check.writes
  // DROP / TRUNCATE / DELETE / ALTER … DROP / UPDATE without WHERE ask on any connection (setting).
  const drops = settings.settings.confirmDestructiveEverywhere
    ? analyzeDestructiveScript(script)
    : []
  if (confirmProduction || drops.length) {
    const allRows = drops.filter((d) => d.allRows).length
    const ok = await confirmDestructive({
      connectionId: connectionId.value,
      title: `Ejecutar en ${typedTarget(connections.get(connectionId.value))}`,
      message: `La consulta puede modificar datos, estructura o estado del servidor (${check.reasons.join(', ')}).`,
      details: script.length > 2000 ? script.slice(0, 2000) + '…' : script,
      alwaysAsk: false,
      destructive: drops.length
        ? {
            title: destructiveTitle(drops.length),
            message:
              'Revisa lo que se va a borrar o eliminar. Esta acción no se puede deshacer.' +
              (allRows
                ? `\n${allRows === 1 ? 'Una sentencia no tiene' : `${allRows} sentencias no tienen`} WHERE y afecta a todas las filas.`
                : ''),
            items: destructiveItems(drops),
            confirmText: 'Ejecutar'
          }
        : undefined
    })
    if (!ok) return
  }

  const seq = ++runSeq
  running.value = true
  notice.value = null
  results.value = []
  pendingEdits.value = {}
  runId.value++
  totalMs.value = null
  const started = performance.now()
  try {
    // confirmProduction tells main the user typed the name; main rejects unconfirmed writes to
    // production and to the environments of Ajustes › Seguridad.
    const out = await api.invokeSilent('db:execute', connectionId.value, script, {
      schema: schema.value,
      ...(confirmProduction ? { confirmProduction: true } : {})
    })
    if (seq !== runSeq) return
    results.value = out
    totalMs.value = Math.round(performance.now() - started)
    const firstSet = resultSets.value[0]
    resultTab.value = errorCount.value || !firstSet ? 'messages' : firstSet.key
  } catch (err) {
    if (seq !== runSeq) return
    notice.value = errorMessage(err)
    resultTab.value = 'messages'
  } finally {
    if (seq === runSeq) running.value = false
    // DDL/DML may have created tables, columns or databases: drop stale completion metadata.
    if (check.writes) completion.value.clear()
  }
}

function stop(): void {
  if (!running.value) return
  // MySQL cannot cancel a statement mid-flight from here: drop late results instead.
  runSeq++
  running.value = false
  notice.value =
    'Ejecución detenida. El servidor puede terminar la sentencia en curso; sus resultados se descartarán.'
  resultTab.value = 'messages'
}

/** Navicat "Embellecer SQL": formats the selection, or the whole editor when nothing is selected. */
function format(): void {
  const selection = editor.value?.getSelection() ?? ''
  const source = selection.trim() ? selection : sql.value
  if (!source.trim()) return
  const result = beautifySql(source)
  if (selection.trim() && editor.value) editor.value.replaceSelection(result.sql)
  else sql.value = result.sql
  if (!result.structured) {
    notify.warning(
      'No se pudo analizar la consulta para embellecerla; solo se pasaron a mayúsculas las palabras clave.'
    )
  }
}

function persist(name: string, id: string | null): void {
  const cid = connectionId.value
  if (!cid) return
  // Saved queries live per connection: a query moved here from another connection is
  // saved on this one (same-name entries are overwritten); the original is left as is.
  const target = id && queries.get(cid, id) ? id : null
  const saved = queries.save(cid, {
    id: target ?? undefined,
    name,
    sql: sql.value,
    schema: schema.value
  })
  savedQueryId.value = saved.id
  savedConnectionId.value = cid
  // Lets useWorkspace.openQuery focus this tab when the saved query is opened from the tree.
  tabs.setPayload(props.tab.id, { savedQueryId: saved.id })
  queryName.value = saved.name
  savedSql.value = sql.value
  updateTitle()
  notify.success(`Consulta "${saved.name}" guardada`)
}

function save(): void {
  if (savedQueryId.value) persist(queryName.value, savedQueryId.value)
  else saveAs()
}

function saveAs(): void {
  saveName.value = savedQueryId.value ? `${queryName.value} (copia)` : ''
  saveDialog.value = true
}

function confirmSaveAs(): void {
  const name = saveName.value.trim()
  if (!name) return
  const clash = queries
    .list(connectionId.value)
    .find((q) => q.name === name && q.id !== savedQueryId.value)
  saveDialog.value = false
  // Saving under an existing name overwrites that query (store dedupes by name).
  persist(name, clash ? clash.id : null)
}

/**
 * Navicat-style connection picker: points this tab at another connection,
 * keeping the SQL. Refused while a query runs; unapplied result edits must be
 * discarded first (the results of the old connection are cleared, never
 * applied to the new one). Keeps the database when the new connection has one
 * with the same name. Production write guards read the tab's connection at run
 * time, so they follow the switch.
 */
async function switchConnection(id: string): Promise<boolean> {
  if (!id || id === connectionId.value || switching.value) return false
  if (running.value) {
    notify.warning('Detén la consulta en curso antes de cambiar de conexión')
    return false
  }
  if (
    hasPendingEdits.value &&
    !(await ask({
      title: 'Cambios sin aplicar',
      message: 'Hay cambios sin aplicar en los resultados. Si cambias de conexión se descartarán.',
      confirmText: 'Descartar y cambiar',
      color: 'warning'
    }))
  )
    return false
  switching.value = true
  try {
    // Opening reports its own error; the tab stays on the current connection.
    if (!(await workspace.ensureOpen(id))) return false
    let names: string[] = []
    try {
      names = (await api.db.databases(id)).map((d) => d.name)
    } catch {
      names = []
    }
    const keep = schema.value && names.includes(schema.value) ? schema.value : null
    // Results (and their editable grids) belong to the old connection.
    runSeq++
    results.value = []
    pendingEdits.value = {}
    runId.value++
    totalMs.value = null
    notice.value = null
    resultTab.value = 'messages'
    schemas.value = names
    tabs.setTarget(props.tab.id, id, keep)
    // Fresh autocompletion metadata: the cache belongs to the old connection.
    completion.value = makeProvider()
    schema.value = keep
    updateTitle()
    void loadCompletion()
    return true
  } finally {
    switching.value = false
  }
}

/**
 * Cmd+R / Cmd+Enter while this tab is active, wherever the focus is. Without it
 * Cmd+R outside the editor reaches Electron's default menu and reloads the
 * whole window, losing every unsaved tab. CodeMirror handles its own keymap
 * first and marks the event as handled.
 */
function onWindowKeydown(event: KeyboardEvent): void {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
  const key = event.key.toLowerCase()
  if (key !== 'r' && key !== 'enter') return
  if (tabs.activeId !== props.tab.id) return
  const handledByEditor = event.defaultPrevented && editorHandled(event)
  event.preventDefault()
  if (handledByEditor || saveDialog.value) return
  void run()
}

function editorHandled(event: KeyboardEvent): boolean {
  return event.target instanceof Element && !!event.target.closest('.cm-editor')
}

let listening = false
function listen(on: boolean): void {
  if (on === listening) return
  listening = on
  if (on) window.addEventListener('keydown', onWindowKeydown)
  else window.removeEventListener('keydown', onWindowKeydown)
}
onActivated(() => listen(true))
onDeactivated(() => listen(false))
onUnmounted(() => listen(false))

onMounted(async () => {
  listen(true)
  loadPayload()
  updateTitle()
  await Promise.all([loadSchemas(), loadCompletion()])
})

/* ---------- AI assistant (never runs SQL: it only reads it or inserts it) ---------- */

const aiEnabled = computed(() => settings.settings.aiEnabled)
const generateOpen = ref(false)

/** Inserts AI-generated SQL at the cursor. Running it goes through run() and its guards. */
function insertAtCursor(text: string): void {
  if (editor.value) editor.value.insertAtCursor(text)
  else sql.value = sql.value ? `${sql.value}\n${text}` : text
}

function onGeneratedSql(text: string): void {
  insertAtCursor(text)
  notify.success('SQL insertado en el editor (no se ha ejecutado)')
}

/** «Explicar / optimizar»: the selection or the whole editor (EXPLAIN only for one SELECT, in main). */
function explainQuery(): void {
  const selection = editor.value?.getSelection() ?? ''
  const source = (selection.trim() ? selection : sql.value).trim()
  if (!source) {
    notify.warning('No hay SQL que explicar')
    return
  }
  void ai.ask('explain', '', { sql: source })
}

function explainError(result: QueryStatementResult): void {
  void ai.ask('explainError', '', { sql: result.sql, error: result.error ?? '' })
}

const unregisterEditor = registerQueryEditor({
  tabId: props.tab.id,
  connectionId: () => connectionId.value,
  schema: () => schema.value,
  sql: () => sql.value,
  selection: () => editor.value?.getSelection() ?? '',
  insertAtCursor
})
onUnmounted(unregisterEditor)

defineExpose({ run, stop, results, schema, switchConnection })
</script>

<template>
  <div class="nd-view query-view">
    <div
      class="nd-viewbar query-view__bar"
      :class="{ 'is-production': production }"
      role="toolbar"
      aria-label="Acciones de consulta"
    >
      <v-btn
        prepend-icon="mdi-play"
        size="small"
        color="primary"
        variant="flat"
        :disabled="running || switching || !connectionId"
        title="Ejecutar (Cmd+R / Cmd+Enter). Si hay texto seleccionado se ejecuta solo la selección."
        data-test="run"
        @click="run()"
      >
        Ejecutar
      </v-btn>
      <v-btn
        prepend-icon="mdi-stop"
        size="small"
        color="error"
        class="ml-1"
        :disabled="!running"
        aria-label="Detener"
        title="Detener"
        data-test="stop"
        @click="stop"
        ><span class="query-view__label">Detener</span></v-btn
      >
      <span class="nd-viewbar__sep" aria-hidden="true" />
      <v-btn
        prepend-icon="mdi-auto-fix"
        size="small"
        title="Embellecer SQL (Cmd+B): la selección o todo el editor"
        aria-label="Embellecer"
        :disabled="running"
        data-test="format"
        @click="format"
      >
        <span class="query-view__label">Embellecer</span>
      </v-btn>
      <v-btn
        prepend-icon="mdi-content-save-outline"
        size="small"
        :title="saveTitle"
        aria-label="Guardar"
        data-test="save"
        @click="save"
        ><span class="query-view__label">Guardar</span
        ><v-icon
          v-if="savedElsewhere"
          icon="mdi-swap-horizontal"
          size="14"
          class="query-view__moved"
          aria-label="Se guardará en la conexión actual"
          data-test="save-moved"
      /></v-btn>
      <v-btn
        prepend-icon="mdi-content-save-edit-outline"
        size="small"
        title="Guardar como"
        aria-label="Guardar como"
        data-test="save-as"
        @click="saveAs"
        ><span class="query-view__label">Guardar como</span></v-btn
      >
      <template v-if="aiEnabled">
        <span class="nd-viewbar__sep" aria-hidden="true" />
        <v-btn
          prepend-icon="mdi-creation-outline"
          size="small"
          title="Generar SQL con IA: se inserta en el editor, no se ejecuta"
          aria-label="Generar SQL con IA"
          :disabled="!connectionId"
          data-test="ai-generate"
          @click="generateOpen = true"
          ><span class="query-view__label">Generar SQL con IA</span></v-btn
        >
        <v-btn
          prepend-icon="mdi-lightbulb-on-outline"
          size="small"
          title="Explicar / optimizar la selección o todo el editor con IA (se envía tu SQL; EXPLAIN solo para un SELECT)"
          aria-label="Explicar / optimizar"
          :disabled="!connectionId || ai.busy"
          data-test="ai-explain"
          @click="explainQuery"
          ><span class="query-view__label">Explicar / optimizar</span></v-btn
        >
      </template>
      <span class="nd-viewbar__spacer" />
      <QueryConnectionPicker
        :model-value="connectionId"
        :connections="connections.sorted"
        :typed-environments="settings.typedEnvironments"
        :disabled="running || switching"
        :disabled-reason="connectionLockReason"
        class="query-view__conn"
        @update:model-value="switchConnection"
      />
      <v-select
        v-model="schema"
        :items="schemas"
        :disabled="switching"
        placeholder="Base de datos"
        aria-label="Base de datos"
        prepend-inner-icon="mdi-database-outline"
        density="compact"
        clearable
        hide-details
        no-data-text="Sin bases de datos"
        class="query-view__schema"
        data-test="schema"
      />
    </div>

    <div ref="body" class="query-view__body" :class="{ 'is-resizing': resizing }">
      <div class="nd-viewpanel query-view__editor" :style="{ height: `${editorPct}%` }">
        <SqlEditor
          ref="editor"
          v-model="sql"
          :provider="completion"
          min-height="80px"
          @run="run()"
          @save="save"
          @beautify="format"
        />
      </div>

      <div
        class="query-view__splitter"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Redimensionar editor y resultados"
        :aria-valuenow="editorPct"
        :aria-valuemin="SPLIT_MIN"
        :aria-valuemax="SPLIT_MAX"
        tabindex="0"
        @pointerdown="startResize"
        @keydown="onSplitKey"
      >
        <span class="query-view__grip" aria-hidden="true" />
      </div>

      <div class="nd-viewpanel query-view__results">
        <div class="query-view__rail">
          <v-tabs
            v-model="resultTab"
            density="compact"
            show-arrows
            hide-slider
            class="query-view__tabs"
          >
            <v-tab value="messages" data-test="tab-messages">
              <v-icon icon="mdi-message-text-outline" size="14" class="query-view__tab-icon" />
              Mensajes
              <span
                v-if="errorCount"
                class="query-view__count query-view__count--error"
                :aria-label="`${errorCount} error(es)`"
                >{{ errorCount }}</span
              >
            </v-tab>
            <v-tab
              v-for="rs in resultSets"
              :key="rs.key"
              :value="rs.key"
              :data-test="`tab-${rs.key}`"
            >
              <v-icon icon="mdi-table" size="14" class="query-view__tab-icon" />
              {{ rs.label }}
              <span class="query-view__count">{{ rs.set.rows.length }}</span>
              <span
                v-if="pendingEdits[rs.key]"
                class="query-view__pending-dot"
                title="Cambios sin aplicar"
                aria-label="Cambios sin aplicar"
              />
            </v-tab>
          </v-tabs>
          <!-- Every tab in one list: the rail scrolls when many results do not fit. -->
          <v-menu v-if="resultSets.length > 1" location="bottom start">
            <template #activator="{ props: menuProps }">
              <v-btn
                v-bind="menuProps"
                icon="mdi-format-list-bulleted"
                size="small"
                variant="text"
                class="query-view__all"
                aria-label="Todos los resultados"
                title="Todos los resultados"
                data-test="results-menu"
              />
            </template>
            <v-list density="compact" class="query-view__all-list" aria-label="Resultados">
              <v-list-item
                prepend-icon="mdi-message-text-outline"
                title="Mensajes"
                :active="resultTab === 'messages'"
                @click="resultTab = 'messages'"
              >
                <template v-if="errorCount" #append>
                  <span class="query-view__count query-view__count--error">{{ errorCount }}</span>
                </template>
              </v-list-item>
              <v-list-item
                v-for="rs in resultSets"
                :key="rs.key"
                prepend-icon="mdi-table"
                :title="rs.label"
                :active="resultTab === rs.key"
                :data-test="`menu-${rs.key}`"
                @click="resultTab = rs.key"
              >
                <template #append>
                  <span
                    v-if="pendingEdits[rs.key]"
                    class="query-view__pending-dot"
                    aria-label="Cambios sin aplicar"
                  />
                  <span class="query-view__count">{{ rs.set.rows.length }}</span>
                </template>
              </v-list-item>
            </v-list>
          </v-menu>
          <span class="nd-viewbar__spacer" />
          <div class="query-view__status" aria-live="polite" data-test="query-status">
            <template v-if="running">
              <span class="query-view__pulse" aria-hidden="true" />
              <span>Ejecutando…</span>
            </template>
            <template v-else-if="totalMs !== null">
              <span class="query-view__status-count">{{ results.length }} sentencia(s) ·</span>
              <span>{{ formatDuration(totalMs) }}</span>
            </template>
          </div>
        </div>
        <v-progress-linear
          v-if="running"
          indeterminate
          color="primary"
          height="2"
          class="query-view__progress"
        />
        <v-window v-model="resultTab" class="query-view__window">
          <v-window-item value="messages" class="fill">
            <QueryMessages
              :results="results"
              :notice="notice"
              :can-explain="aiEnabled"
              @explain-error="explainError"
            />
          </v-window-item>
          <v-window-item v-for="rs in resultSets" :key="rs.key" :value="rs.key" class="fill">
            <EditableResult
              :key="`${runId}-${rs.key}`"
              :connection-id="connectionId"
              :sql="rs.sql"
              :columns="rs.set.columns"
              :rows="rs.set.rows"
              :truncated="rs.set.truncated"
              @dirty="setPendingEdits(rs.key, $event)"
            />
          </v-window-item>
        </v-window>
      </div>
    </div>

    <AiGenerateSqlDialog v-model="generateOpen" :editor-sql="sql" @insert="onGeneratedSql" />

    <v-dialog v-model="saveDialog" max-width="440">
      <v-card>
        <v-card-title class="d-flex align-center ga-3">
          <span class="nd-icon-badge"><v-icon icon="mdi-content-save-outline" size="18" /></span>
          Guardar consulta
        </v-card-title>
        <v-card-text>
          <v-text-field
            v-model="saveName"
            label="Nombre de la consulta"
            autofocus
            data-test="save-name"
            @keydown.enter="confirmSaveAs"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="saveDialog = false">Cancelar</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            :disabled="!saveName.trim()"
            data-test="save-confirm"
            @click="confirmSaveAs"
          >
            Guardar
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped src="../components/data/viewChrome.css"></style>
<style scoped>
/* Production connection: a red rule under the toolbar, on top of the red picker. */
.query-view__bar {
  /* Size container: secondary buttons drop their labels before the pickers get squeezed. */
  container: qbar / inline-size;
  flex-wrap: wrap;
  row-gap: 4px;
  border-bottom: 2px solid transparent;
}
@container qbar (max-width: 1060px) {
  .query-view__label {
    display: none;
  }
  .query-view__bar :deep(.v-btn:has(.query-view__label) .v-btn__prepend) {
    margin-inline: 0;
  }
  .query-view__bar :deep(.v-btn:has(.query-view__label)) {
    min-width: 0;
    padding: 0 8px;
  }
}
.query-view__bar.is-production {
  border-bottom-color: color-mix(in srgb, var(--nd-error) 55%, transparent);
  background: linear-gradient(to bottom, transparent, var(--nd-error-soft));
}
.query-view__conn {
  margin-right: 6px;
}
.query-view__moved {
  margin-left: 4px;
  color: var(--nd-warning);
}
.query-view__schema {
  /* Small basis: the bar wraps only when the minimum widths no longer fit. */
  flex: 1 1 170px;
  min-width: 170px;
  max-width: 240px;
}
.query-view__body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  padding-bottom: 12px;
}
.query-view__body.is-resizing {
  cursor: row-resize;
  user-select: none;
}
.query-view__editor {
  flex: 0 0 auto;
  min-height: 80px;
  margin-bottom: 0;
  background: var(--nd-bg-sunken);
}
.query-view__editor:focus-within {
  border-color: rgba(var(--nd-accent-rgb), 0.45);
  box-shadow: var(--nd-glow);
}
.query-view__splitter {
  position: relative;
  flex: 0 0 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 12px;
  cursor: row-resize;
  border-radius: var(--nd-radius-sm);
  touch-action: none;
}
.query-view__grip {
  width: 36px;
  height: 3px;
  border-radius: var(--nd-radius-pill);
  background: var(--nd-border-strong);
  transition:
    background var(--nd-dur) var(--nd-ease),
    width var(--nd-dur) var(--nd-ease);
}
.query-view__splitter:hover .query-view__grip,
.query-view__body.is-resizing .query-view__grip,
.query-view__splitter:focus-visible .query-view__grip {
  width: 64px;
  background: var(--nd-accent-gradient-h);
}
.query-view__splitter:focus-visible {
  box-shadow: none;
}
.query-view__results {
  flex: 1 1 auto;
  min-height: 80px;
  margin-bottom: 0;
}
.query-view__rail {
  /* Size container: the status gives up its room before the tabs do (see below). */
  container: qrail / inline-size;
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  min-height: 48px;
  padding: 6px 12px 6px 6px;
  border-bottom: 1px solid var(--nd-hairline);
  background: var(--nd-bg-raised);
}
.query-view__tabs {
  /* Pill height; the track grows around it (Vuetify would pin it to this height and clip the pills). */
  --v-tabs-height: 28px;
  height: auto;
  min-width: 0;
  padding: 3px;
  border-radius: var(--nd-radius-pill);
  background: var(--nd-bg-sunken);
  border: 1px solid var(--nd-border);
}
/* Slide arrows only when the pills overflow: keep them slim so pills keep the room. */
.query-view__tabs :deep(.v-slide-group__prev),
.query-view__tabs :deep(.v-slide-group__next) {
  flex: 0 0 24px;
  min-width: 24px;
  border-radius: var(--nd-radius-pill);
}
.query-view__all {
  flex: none;
  color: var(--nd-text-2);
}
.query-view__all-list .query-view__count {
  margin-left: 12px;
}
.query-view__all-list .query-view__pending-dot {
  margin: 0 4px 0 0;
}
/* Segmented pills: a visible gutter between tabs so they never touch. */
.query-view__tabs :deep(.v-slide-group__content) {
  gap: 4px;
}
.query-view__tabs :deep(.v-tab.v-tab.v-btn) {
  position: relative;
  height: var(--v-tabs-height);
  padding: 0 14px 0 12px;
  font-size: var(--nd-fs-dense);
  border-radius: var(--nd-radius-pill);
  transition:
    background-color var(--nd-dur) var(--nd-ease),
    color var(--nd-dur) var(--nd-ease),
    box-shadow var(--nd-dur) var(--nd-ease);
}
.query-view__tabs :deep(.v-tab .v-btn__content) {
  gap: 0;
  line-height: 1;
}
.query-view__tabs :deep(.v-tab.v-tab--selected) {
  background: var(--nd-bg-raised);
  box-shadow:
    var(--nd-shadow-1),
    inset 0 0 0 1px var(--nd-border-strong);
}
.query-view__tabs :deep(.v-tab.v-tab--selected::after) {
  content: '';
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 1px;
  height: 2px;
  border-radius: 2px;
  background: var(--nd-accent-gradient-h);
  box-shadow: 0 0 8px rgba(var(--nd-accent-rgb), 0.45);
}
.query-view__tab-icon {
  margin-right: 8px;
}
.query-view__tabs :deep(.v-tab .v-icon) {
  color: var(--nd-text-muted);
}
.query-view__tabs :deep(.v-tab--selected .v-icon) {
  color: var(--nd-accent);
}
.query-view__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 10px;
  padding: 0 7px;
  min-width: 22px;
  height: 18px;
  border-radius: var(--nd-radius-pill);
  font-family: var(--nd-font-mono);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: var(--nd-text-2);
  background: var(--nd-hover);
  border: 1px solid var(--nd-hairline);
}
.query-view__count--error {
  color: var(--nd-error);
  background: var(--nd-error-soft);
  border-color: color-mix(in srgb, var(--nd-error) 30%, transparent);
}
.query-view__pending-dot {
  width: 6px;
  height: 6px;
  margin-left: 8px;
  border-radius: 50%;
  background: var(--nd-warning);
  box-shadow: 0 0 6px var(--nd-warning);
}
.query-view__status {
  /* Never squeezed into a misleading fragment: parts are hidden by width instead (below). */
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 28px;
  padding: 0 4px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  white-space: nowrap;
}
/* Narrow panel: the statement count lives in Mensajes; below that, only the tabs remain. */
@container qrail (max-width: 760px) {
  .query-view__status-count {
    display: none;
  }
}
@container qrail (max-width: 420px) {
  .query-view__status {
    display: none;
  }
}
.query-view__pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--nd-accent);
  box-shadow: 0 0 8px var(--nd-accent);
  animation: query-pulse 1.1s var(--nd-ease) infinite alternate;
}
@keyframes query-pulse {
  from {
    opacity: 0.35;
  }
  to {
    opacity: 1;
  }
}
.query-view__progress {
  flex: 0 0 auto;
}
.query-view__window {
  flex: 1 1 auto;
  min-height: 0;
}
.query-view__window :deep(.v-window__container),
.fill {
  height: 100%;
}

/*
 * Result grid column sizing (layout only). Every real column shrinks to its
 * content (header + values, capped below) and a trailing pseudo cell absorbs
 * the leftover width, so short columns stay next to each other instead of
 * the browser spreading the spare space evenly across all of them.
 */
.query-view__window :deep(.result-grid__table > .v-table__wrapper > table > * > tr > th),
.query-view__window :deep(.result-grid__table > .v-table__wrapper > table > * > tr > td) {
  width: 1%;
  min-width: 56px;
}
.query-view__window :deep(.result-grid__table > .v-table__wrapper > table > * > tr::after) {
  content: '';
  display: table-cell;
  border-bottom: 1px solid var(--nd-hairline);
}
.query-view__window :deep(.result-grid__table > .v-table__wrapper > table > thead > tr::after) {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--nd-bg-panel);
  border-bottom: none;
  box-shadow: inset 0 -1px 0 var(--nd-border);
}
.query-view__window
  :deep(.result-grid__table > .v-table__wrapper > table > tbody > tr:hover::after) {
  background: var(--nd-hover);
}
.query-view__window :deep(.result-grid__cell) {
  display: inline-block;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
}
</style>
