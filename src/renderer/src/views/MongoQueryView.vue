<script setup lang="ts">
/**
 * MongoDB query tab (docs/multi-engine-design.md, 9.3): shell-syntax
 * statements on a whitelisted grammar (parsed in main, never eval'd), the
 * tab's own session (`use <db>` and, on replica sets, a transaction), cancel
 * with killOp, completion of collections, methods, operators and sampled
 * field names, and results as messages or editable documents.
 */
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import type { MongoCommandResult, MongoDocumentPage, TransactionStatus } from '@shared/types'
import { analyzeMongoWrites } from '@shared/mongo/classify'
import { parseEjson, shellText, type EjsonObject } from '@shared/mongo/shellFormat'
import { api, newOperationId } from '@renderer/api'
import SqlEditor from '@renderer/components/common/SqlEditor.vue'
import QueryConnectionPicker from '@renderer/components/query/QueryConnectionPicker.vue'
import DocumentBrowser from '@renderer/components/mongo/DocumentBrowser.vue'
import type { DocumentMode } from '@renderer/components/mongo/docModel'
import {
  cachedMongoProvider,
  mongoCompletionSource
} from '@renderer/components/common/editor/mongoCompletion'
import { typedTarget, useConfirm } from '@renderer/composables/useConfirm'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useTransactionPrompt } from '@renderer/composables/useTransactionPrompt'
import { useWorkspace } from '@renderer/composables/useWorkspace'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useQueriesStore } from '@renderer/stores/queries'
import { useSettingsStore } from '@renderer/stores/settings'
import { useTabsStore, type WorkspaceTab } from '@renderer/stores/tabs'
import { formatDuration, formatNumber } from '@renderer/utils/format'

const props = defineProps<{ tab: WorkspaceTab }>()

const tabs = useTabsStore()
const connections = useConnectionsStore()
const queries = useQueriesStore()
const settings = useSettingsStore()
const notify = useNotify()
const workspace = useWorkspace()
const { confirmDestructive, ask } = useConfirm()
const txPrompt = useTransactionPrompt()

const editor = ref<InstanceType<typeof SqlEditor> | null>(null)
const script = ref('')
const savedScript = ref('')
const savedQueryId = ref<string | null>(null)
const queryName = ref('Consulta sin título')
const database = ref<string | null>(props.tab.schema ?? null)
const databases = ref<string[]>([])
const running = ref(false)
const results = ref<MongoCommandResult[]>([])
const notice = ref<string | null>(null)
const resultTab = ref('messages')
const totalMs = ref<number | null>(null)
const txStatus = ref<TransactionStatus>('idle')
const saveDialog = ref(false)
const saveName = ref('')
const pending = ref<Record<number, number>>({})
const modes = ref<Record<number, DocumentMode>>({})
const localTime = ref(false)
let executionId: string | null = null
let runSeq = 0

const connectionId = computed(() => props.tab.connectionId ?? '')
const conn = computed(() => connections.get(connectionId.value))
const production = computed(() => connections.isProduction(connectionId.value))
const runtime = computed(() => connections.serverInfo[connectionId.value]?.runtime)
const transactions = computed(() => runtime.value?.transactions === true)
const mongoConnections = computed(() => connections.items.filter((c) => c.engine === 'mongodb'))
const hasPending = computed(() => Object.values(pending.value).some((n) => n > 0))
const dirty = computed(() => script.value !== savedScript.value || hasPending.value)
watch(dirty, (value) => tabs.setDirty(props.tab.id, value), { immediate: true })

const documentResults = computed(() =>
  results.value
    .map((r, index) => ({ r, index }))
    .filter((x) => x.r.kind === 'documents' && x.r.page)
)
const errorCount = computed(() => results.value.filter((r) => r.kind === 'error').length)

/* ---------- completion ---------- */

function makeProvider() {
  return cachedMongoProvider({
    databases: async () => (await api.db.databases(connectionId.value)).map((d) => d.name),
    collections: async () =>
      database.value
        ? (await api.mongo.collections(connectionId.value, database.value)).map((c) => c.name)
        : [],
    fields: async (collection) =>
      database.value
        ? (await api.mongo.sampleFields(connectionId.value, database.value, collection, 200)).map(
            (f) => f.path
          )
        : []
  })
}
const provider = ref(makeProvider())
const completion = computed(() => mongoCompletionSource(provider.value))

/* ---------- title, databases, saved queries ---------- */

function updateTitle(): void {
  const where = database.value ? `@${database.value}` : ''
  tabs.setTitle(
    props.tab.id,
    `${queryName.value}${where} (${connections.nameOf(connectionId.value)})`
  )
}

async function loadDatabases(): Promise<void> {
  if (!connectionId.value) return
  try {
    const list = (await api.db.databases(connectionId.value)).map((d) => d.name)
    const custom = conn.value?.customDatabases ?? []
    databases.value = custom.length ? list.filter((d) => custom.includes(d)) : list
  } catch {
    databases.value = []
  }
  if (!database.value) {
    const preferred = conn.value?.mongo?.defaultDatabase
    database.value =
      (preferred && databases.value.includes(preferred) ? preferred : null) ??
      databases.value.find((d) => !['admin', 'local', 'config'].includes(d)) ??
      databases.value[0] ??
      preferred ??
      null
  }
}

watch(database, (value) => {
  tabs.setTarget(props.tab.id, connectionId.value, value)
  provider.value = makeProvider()
  updateTitle()
})

function loadPayload(): void {
  const payload = props.tab.payload ?? {}
  const id = typeof payload.savedQueryId === 'string' ? payload.savedQueryId : null
  if (id && connectionId.value) {
    const saved = queries.get(connectionId.value, id)
    if (saved) {
      savedQueryId.value = saved.id
      queryName.value = saved.name
      script.value = saved.sql
      savedScript.value = saved.sql
      if (saved.schema) database.value = saved.schema
      return
    }
    notify.warning('No se encontró la consulta guardada')
  }
  if (typeof payload.name === 'string' && payload.name) queryName.value = payload.name
  if (typeof payload.sql === 'string') script.value = payload.sql
}

function persist(name: string, id: string | null): void {
  const cid = connectionId.value
  if (!cid) return
  const target = id && queries.get(cid, id) ? id : null
  const saved = queries.save(cid, {
    id: target ?? undefined,
    name,
    sql: script.value,
    schema: database.value
  })
  savedQueryId.value = saved.id
  tabs.setPayload(props.tab.id, { savedQueryId: saved.id })
  queryName.value = saved.name
  savedScript.value = script.value
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
  persist(name, clash ? clash.id : null)
}

/* ---------- run, cancel, transactions ---------- */

const DESTRUCTIVE = /elimina|borra todos|modifica todos/

async function run(): Promise<void> {
  if (running.value || !connectionId.value) return
  const selection = editor.value?.getSelection() ?? ''
  const text = (selection || script.value).trim()
  if (!text) {
    notify.warning('No hay nada que ejecutar')
    return
  }
  if (
    hasPending.value &&
    !(await ask({
      title: 'Cambios sin aplicar',
      message: 'Hay cambios sin aplicar en los resultados. Si vuelves a ejecutar se descartarán.',
      confirmText: 'Descartar y ejecutar',
      color: 'warning'
    }))
  )
    return
  // Allowlist (shared classifier): anything not provably read-only asks on guarded connections.
  const analysis = analyzeMongoWrites(text)
  const guarded = connections.needsTypedConfirm(connectionId.value)
  const confirmProduction = guarded && analysis.writes
  const destructive =
    settings.settings.confirmDestructiveEverywhere !== false &&
    analysis.reasons.some((r) => DESTRUCTIVE.test(r))
  if (confirmProduction || destructive) {
    const ok = await confirmDestructive({
      connectionId: connectionId.value,
      title: `Ejecutar en ${typedTarget(conn.value)}`,
      message: `Las órdenes pueden modificar datos o estructura (${analysis.reasons.join(', ')}).`,
      details: text.length > 2000 ? `${text.slice(0, 2000)}…` : text,
      alwaysAsk: false,
      destructive: destructive
        ? {
            title: 'Órdenes que eliminan datos',
            message: 'Revisa lo que se va a borrar o eliminar. Esta acción no se puede deshacer.',
            items: analysis.reasons.filter((r) => DESTRUCTIVE.test(r)).map((r) => ({ text: r })),
            confirmText: 'Ejecutar'
          }
        : undefined
    })
    if (!ok) return
  }
  await execute(text, confirmProduction)
  if (analysis.writes) provider.value.clear()
}

async function execute(
  text: string,
  confirmProduction: boolean,
  replaceIndex?: number
): Promise<void> {
  const seq = ++runSeq
  running.value = true
  notice.value = null
  if (replaceIndex === undefined) {
    results.value = []
    pending.value = {}
    totalMs.value = null
  }
  const started = performance.now()
  executionId = newOperationId('exec')
  try {
    const out = await api.mongo.execute(connectionId.value, text, {
      database: database.value,
      sessionKey: props.tab.id,
      executionId,
      maxDocs: settings.settings.defaultRowLimit,
      ...(confirmProduction ? { confirmProduction: true } : {})
    })
    if (seq !== runSeq) return
    const last = out[out.length - 1]
    if (last?.transactionStatus) txStatus.value = last.transactionStatus
    if (last?.currentDatabase && last.currentDatabase !== database.value) {
      if (!databases.value.includes(last.currentDatabase))
        databases.value = [...databases.value, last.currentDatabase]
      database.value = last.currentDatabase
    }
    if (replaceIndex !== undefined && out[0]) {
      results.value = results.value.map((r, i) => (i === replaceIndex ? out[0] : r))
      pending.value = { ...pending.value, [replaceIndex]: 0 }
      return
    }
    results.value = out
    totalMs.value = Math.round(performance.now() - started)
    const firstDocs = documentResults.value[0]
    resultTab.value = errorCount.value || !firstDocs ? 'messages' : `r${firstDocs.index}`
  } catch (err) {
    if (seq !== runSeq) return
    notice.value = errorMessage(err)
    resultTab.value = 'messages'
  } finally {
    if (seq === runSeq) {
      running.value = false
      executionId = null
    }
  }
}

async function stop(): Promise<void> {
  if (!executionId) return
  const id = executionId
  const ok = await api.db.cancel(connectionId.value, id).catch(() => false)
  if (!ok) notify.warning('La consulta ya había terminado')
}

async function refreshSessionState(): Promise<void> {
  try {
    txStatus.value = (await api.db.sessionState(connectionId.value, props.tab.id)).transactionStatus
  } catch {
    txStatus.value = 'idle'
  }
}

async function beginTransaction(): Promise<void> {
  try {
    txStatus.value = (
      await api.mongo.beginTransaction(connectionId.value, props.tab.id)
    ).transactionStatus
  } catch {
    /* shown by api.invoke */
  }
}
async function commitTransaction(): Promise<void> {
  const state = await txPrompt.commit(connectionId.value, props.tab.id)
  if (state) {
    txStatus.value = state.transactionStatus
    notify.success('Transacción confirmada')
  }
}
async function rollbackTransaction(): Promise<void> {
  const state = await txPrompt.rollback(connectionId.value, props.tab.id)
  if (state) {
    txStatus.value = state.transactionStatus
    notify.info('Transacción deshecha')
  }
}

/* ---------- results ---------- */

async function reloadResult(index: number): Promise<void> {
  const r = results.value[index]
  if (!r || r.kind !== 'documents') return
  // A documents result comes from a read (find / findOne / aggregate without $out): safe to repeat.
  await execute(
    r.database
      ? `db.getSiblingDB(${JSON.stringify(r.database)}).${r.statement.replace(/^db\./, '')}`
      : r.statement,
    false,
    index
  )
}

async function loadMore(index: number): Promise<void> {
  const r = results.value[index]
  const page = r?.page
  if (!page?.resultId) return
  try {
    const more = await api.mongo.getMore(
      connectionId.value,
      page.resultId,
      settings.settings.defaultRowLimit
    )
    const merged: MongoDocumentPage = {
      ...page,
      docs: [...page.docs, ...more.docs],
      whole: [...page.whole, ...more.whole],
      fields: page.fields,
      truncated: more.truncated,
      resultId: more.resultId
    }
    results.value = results.value.map((x, i) => (i === index ? { ...x, page: merged } : x))
  } catch {
    /* shown by api.invoke */
  }
}

function summary(r: MongoCommandResult): string {
  if (r.kind === 'error') return r.error ?? 'Error'
  if (r.kind === 'documents') {
    const n = r.page?.docs.length ?? 0
    return `${formatNumber(n)} documento(s)${r.page?.truncated ? ' (hay más: «Cargar más»)' : ''}`
  }
  if (r.kind === 'write' && r.write) {
    const w = r.write
    const parts = [
      w.inserted !== null ? `${w.inserted} insertado(s)` : null,
      w.matched !== null ? `${w.matched} encontrado(s)` : null,
      w.modified !== null ? `${w.modified} modificado(s)` : null,
      w.upserted ? `${w.upserted} creado(s) por upsert` : null,
      w.deleted !== null ? `${w.deleted} eliminado(s)` : null
    ].filter(Boolean)
    return parts.length ? parts.join(' · ') : 'Hecho'
  }
  return ''
}

function valueText(r: MongoCommandResult): string {
  if (r.value === undefined) return ''
  try {
    const parsed = parseEjson(r.value) as EjsonObject
    if (parsed && typeof parsed === 'object' && 'v' in parsed && Object.keys(parsed).length === 1)
      return shellText(parsed.v, { indent: 2, localTime: localTime.value })
  } catch {
    // plain text (show dbs, use…)
  }
  return r.value
}

function onPending(index: number, count: number): void {
  pending.value = { ...pending.value, [index]: count }
}

/* ---------- connection switch ---------- */

async function switchConnection(id: string): Promise<void> {
  if (!id || id === connectionId.value) return
  if (running.value)
    return notify.warning('Detén la consulta en curso antes de cambiar de conexión')
  if (connections.isOpen(connectionId.value)) {
    if (
      !(await txPrompt.settleTransaction(
        connectionId.value,
        props.tab.id,
        'Cambiar de conexión',
        txStatus.value
      ))
    )
      return
    await api.db.closeSession(connectionId.value, props.tab.id).catch(() => undefined)
  }
  if (!(await workspace.ensureOpen(id))) return
  results.value = []
  pending.value = {}
  txStatus.value = 'idle'
  database.value = null
  tabs.setTarget(props.tab.id, id, null)
  provider.value = makeProvider()
  await loadDatabases()
  updateTitle()
}

/* ---------- keyboard ---------- */

function onWindowKeydown(event: KeyboardEvent): void {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
  const key = event.key.toLowerCase()
  if (key !== 'r' && key !== 'enter') return
  if (tabs.activeId !== props.tab.id) return
  const handledByEditor =
    event.defaultPrevented &&
    event.target instanceof Element &&
    !!event.target.closest('.cm-editor')
  event.preventDefault()
  if (handledByEditor || saveDialog.value) return
  void run()
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
  await loadDatabases()
  updateTitle()
  await refreshSessionState()
})
</script>

<template>
  <div class="nd-view mongo-query" data-test="mongo-query-view">
    <div
      class="nd-viewbar mongo-query__bar"
      :class="{ 'is-production': production }"
      role="toolbar"
      aria-label="Acciones de consulta"
    >
      <v-btn
        prepend-icon="mdi-play"
        size="small"
        color="primary"
        variant="flat"
        :disabled="running || !connectionId"
        title="Ejecutar (Cmd+R / Cmd+Enter). Si hay texto seleccionado se ejecuta solo la selección."
        data-test="run"
        @click="run"
        >Ejecutar</v-btn
      >
      <v-btn
        prepend-icon="mdi-stop"
        size="small"
        color="error"
        class="ml-1"
        :disabled="!running"
        data-test="stop"
        @click="stop"
        >Detener</v-btn
      >
      <span class="nd-viewbar__sep" aria-hidden="true" />
      <v-btn prepend-icon="mdi-content-save-outline" size="small" data-test="save" @click="save"
        >Guardar</v-btn
      >
      <v-btn prepend-icon="mdi-content-save-edit-outline" size="small" @click="saveAs"
        >Guardar como</v-btn
      >
      <template v-if="transactions">
        <span class="nd-viewbar__sep" aria-hidden="true" />
        <v-btn
          v-if="txStatus === 'idle'"
          prepend-icon="mdi-source-branch-plus"
          size="small"
          title="Las órdenes siguientes de esta pestaña irán en una transacción hasta confirmarla o deshacerla"
          data-test="tx-begin"
          @click="beginTransaction"
          >Iniciar transacción</v-btn
        >
        <template v-else>
          <span
            class="nd-status-pill"
            :class="txStatus === 'failed' ? 'nd-status-pill--error' : 'nd-status-pill--warning'"
            data-test="tx-status"
            >{{ txStatus === 'failed' ? 'Transacción abortada' : 'Transacción abierta' }}</span
          >
          <v-btn
            prepend-icon="mdi-check"
            size="small"
            :disabled="txStatus === 'failed'"
            data-test="tx-commit"
            @click="commitTransaction"
            >Confirmar</v-btn
          >
          <v-btn
            prepend-icon="mdi-undo-variant"
            size="small"
            data-test="tx-rollback"
            @click="rollbackTransaction"
            >Deshacer</v-btn
          >
        </template>
      </template>
      <span class="nd-viewbar__spacer" />
      <QueryConnectionPicker
        :model-value="connectionId"
        :connections="mongoConnections"
        :disabled="running"
        :typed-environments="settings.settings.typedConfirmEnvironments"
        class="mongo-query__conn"
        @update:model-value="switchConnection"
      />
      <v-combobox
        v-model="database"
        :items="databases"
        label="Base de datos"
        density="compact"
        hide-details
        class="mongo-query__db"
        data-test="mongo-database"
      />
    </div>

    <div class="mongo-query__body">
      <div class="nd-viewpanel mongo-query__editor">
        <SqlEditor
          ref="editor"
          v-model="script"
          engine="mongodb"
          :completion-source="completion"
          min-height="120px"
          @run="run"
          @save="save"
        />
      </div>

      <div class="nd-viewpanel mongo-query__results">
        <div class="mongo-query__rail">
          <v-tabs v-model="resultTab" density="compact" class="mongo-query__tabs" show-arrows>
            <v-tab value="messages" data-test="tab-messages"
              >Mensajes<span v-if="errorCount" class="mongo-query__errors">{{
                errorCount
              }}</span></v-tab
            >
            <v-tab
              v-for="(d, n) in documentResults"
              :key="d.index"
              :value="`r${d.index}`"
              :data-test="`tab-result-${n}`"
              >Resultado {{ n + 1
              }}<span
                v-if="pending[d.index]"
                class="mongo-query__pending"
                aria-label="cambios sin aplicar"
            /></v-tab>
          </v-tabs>
          <v-spacer />
          <span v-if="running" class="text-caption text-medium-emphasis">Ejecutando…</span>
          <span v-else-if="totalMs !== null" class="text-caption text-medium-emphasis">{{
            formatDuration(totalMs)
          }}</span>
        </div>
        <div class="mongo-query__result-body">
          <div
            v-if="resultTab === 'messages'"
            class="mongo-query__messages"
            data-test="mongo-messages"
          >
            <v-alert
              v-if="notice"
              type="error"
              variant="tonal"
              density="compact"
              class="mb-2"
              data-test="mongo-notice"
              >{{ notice }}</v-alert
            >
            <div v-if="!results.length && !notice" class="text-caption text-medium-emphasis pa-2">
              Escribe órdenes como <span class="nd-mono">db.pedidos.find({ estado: 'A' })</span> o
              <span class="nd-mono">db.pedidos.aggregate([...])</span> y pulsa Ejecutar. También
              <span class="nd-mono">use &lt;bd&gt;</span>,
              <span class="nd-mono">show collections</span> y
              <span class="nd-mono">db.stats()</span>.
            </div>
            <div
              v-for="(r, i) in results"
              :key="i"
              class="mongo-query__message"
              :class="{ 'is-error': r.kind === 'error' }"
            >
              <div class="mongo-query__message-head">
                <v-icon
                  :icon="
                    r.kind === 'error'
                      ? 'mdi-alert-circle-outline'
                      : r.kind === 'write'
                        ? 'mdi-pencil-outline'
                        : r.kind === 'documents'
                          ? 'mdi-file-document-multiple-outline'
                          : 'mdi-information-outline'
                  "
                  size="15"
                />
                <span class="nd-mono mongo-query__statement" :title="r.statement">{{
                  r.statement
                }}</span>
                <span class="text-caption text-medium-emphasis">{{
                  formatDuration(r.durationMs)
                }}</span>
              </div>
              <div class="mongo-query__message-body">
                <span v-if="summary(r)">{{ summary(r) }}</span>
                <v-btn
                  v-if="r.kind === 'documents'"
                  size="x-small"
                  variant="text"
                  @click="resultTab = `r${i}`"
                  >Ver</v-btn
                >
              </div>
              <pre v-if="r.kind === 'value'" class="mongo-query__value nd-mono">{{
                valueText(r)
              }}</pre>
            </div>
          </div>
          <template v-for="d in documentResults" :key="d.index">
            <DocumentBrowser
              v-if="resultTab === `r${d.index}`"
              v-model:mode="modes[d.index]"
              v-model:local-time="localTime"
              :connection-id="connectionId"
              :database="d.r.database ?? database ?? ''"
              :collection="d.r.collection ?? ''"
              :page="d.r.page ?? null"
              :read-only-reason="d.r.readOnlyReason ?? null"
              @reload="reloadResult(d.index)"
              @load-more="loadMore(d.index)"
              @pending="onPending(d.index, $event)"
            />
          </template>
        </div>
      </div>
    </div>

    <v-dialog v-model="saveDialog" max-width="420">
      <v-card>
        <v-card-title class="text-subtitle-1">Guardar consulta</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="saveName"
            label="Nombre"
            autofocus
            @keydown.enter="confirmSaveAs"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="saveDialog = false">Cancelar</v-btn>
          <v-btn color="primary" variant="flat" @click="confirmSaveAs">Guardar</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped src="@renderer/components/data/viewChrome.css"></style>
<style scoped>
.nd-status-pill--error {
  color: var(--nd-error);
  background: var(--nd-error-soft);
}
.mongo-query__bar {
  flex-wrap: wrap;
  row-gap: 4px;
  border-bottom: 2px solid transparent;
}
.mongo-query__bar.is-production {
  border-bottom-color: color-mix(in srgb, var(--nd-error) 55%, transparent);
  background: linear-gradient(to bottom, transparent, var(--nd-error-soft));
}
.mongo-query__conn {
  margin-right: 6px;
}
.mongo-query__db {
  flex: 0 1 220px;
  min-width: 170px;
}
.mongo-query__body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
.mongo-query__editor {
  flex: 0 0 34%;
  min-height: 120px;
  margin-bottom: 8px;
}
.mongo-query__results {
  flex: 1 1 auto;
  min-height: 120px;
}
.mongo-query__rail {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 4px 12px 4px 6px;
  border-bottom: 1px solid var(--nd-hairline);
  background: var(--nd-bg-raised);
}
.mongo-query__tabs {
  min-width: 0;
}
.mongo-query__tabs :deep(.v-tab) {
  text-transform: none;
  font-size: var(--nd-fs-dense);
}
.mongo-query__errors {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: var(--nd-radius-pill);
  font-size: var(--nd-fs-xs);
  color: var(--nd-error);
  background: var(--nd-error-soft);
}
.mongo-query__pending {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 6px;
  border-radius: 50%;
  background: var(--nd-warning);
}
.mongo-query__result-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
.mongo-query__messages {
  height: 100%;
  overflow: auto;
  padding: 8px 12px;
}
.mongo-query__message {
  padding: 6px 0;
  border-bottom: 1px solid var(--nd-hairline);
  font-size: var(--nd-fs-dense);
}
.mongo-query__message.is-error {
  color: var(--nd-error);
}
.mongo-query__message-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mongo-query__statement {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mongo-query__message-body {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 2px 0 0 23px;
  color: var(--nd-text-2);
}
.mongo-query__message.is-error .mongo-query__message-body {
  color: var(--nd-error);
  white-space: pre-wrap;
}
.mongo-query__value {
  margin: 4px 0 0 23px;
  padding: 6px 8px;
  max-height: 320px;
  overflow: auto;
  font-size: var(--nd-fs-dense);
  background: var(--nd-bg-sunken);
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-control);
  white-space: pre-wrap;
}
</style>
