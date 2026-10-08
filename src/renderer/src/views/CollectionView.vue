<script setup lang="ts">
/**
 * MongoDB collection browser (docs/multi-engine-design.md, 9.1): filter,
 * sort and projection in shell syntax (parsed in main), skip/limit paging
 * plus «Cargar más» through the open cursor, the count (≈ when estimated),
 * the documents in three modes and a read-only index panel.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { MongoCollectionDetails, MongoDocumentPage } from '@shared/types'
import { api } from '@renderer/api'
import { errorMessage } from '@renderer/composables/useNotify'
import { useWorkspace } from '@renderer/composables/useWorkspace'
import { useTabsStore, type WorkspaceTab } from '@renderer/stores/tabs'
import { formatDuration, formatNumber } from '@renderer/utils/format'
import DocumentBrowser from '@renderer/components/mongo/DocumentBrowser.vue'
import { keysSummaryOf, type DocumentMode } from '@renderer/components/mongo/docModel'
import { readHistory, rememberHistory } from '@renderer/components/mongo/filterHistory'

const props = defineProps<{ tab: WorkspaceTab }>()
const tabs = useTabsStore()
const workspace = useWorkspace()

const connectionId = computed(() => props.tab.connectionId ?? '')
const database = computed(() => props.tab.schema ?? '')
const collection = computed(() => props.tab.objectName ?? '')

const saved = (props.tab.payload ?? {}) as {
  filter?: string
  sort?: string
  projection?: string
  limit?: number
  mode?: DocumentMode
  localTime?: boolean
  showIndexes?: boolean
}
const filter = ref(saved.filter ?? '')
const sort = ref(saved.sort ?? '')
const projection = ref(saved.projection ?? '')
const limit = ref(saved.limit ?? 100)
const skip = ref(0)
const mode = ref<DocumentMode>(saved.mode ?? 'table')
const localTime = ref(saved.localTime ?? false)
const showIndexes = ref(saved.showIndexes ?? false)

const page = ref<MongoDocumentPage | null>(null)
const details = ref<MongoCollectionDetails | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const history = ref(readHistory(connectionId.value, database.value, collection.value))
let executionId: string | null = null

watch([mode, localTime, showIndexes, limit], () =>
  tabs.setPayload(props.tab.id, {
    mode: mode.value,
    localTime: localTime.value,
    showIndexes: showIndexes.value,
    limit: limit.value
  })
)

const readOnlyReason = computed(() => details.value?.info.readOnlyReason ?? null)

async function closeCursor(): Promise<void> {
  const id = page.value?.resultId
  if (id) await api.mongo.closeCursor(connectionId.value, id).catch(() => undefined)
}

async function loadDetails(): Promise<void> {
  try {
    details.value = await api.mongo.collectionDetails(
      connectionId.value,
      database.value,
      collection.value
    )
  } catch {
    details.value = null
  }
}

async function load(): Promise<void> {
  await closeCursor()
  loading.value = true
  error.value = null
  executionId = crypto.randomUUID()
  try {
    page.value = await api.mongo.find(connectionId.value, {
      database: database.value,
      collection: collection.value,
      filter: filter.value,
      sort: sort.value,
      projection: projection.value,
      skip: skip.value,
      limit: limit.value,
      executionId
    })
    history.value = rememberHistory(connectionId.value, database.value, collection.value, {
      filter: filter.value,
      sort: sort.value,
      projection: projection.value
    })
    tabs.setPayload(props.tab.id, {
      filter: filter.value,
      sort: sort.value,
      projection: projection.value
    })
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    loading.value = false
    executionId = null
  }
}

async function search(): Promise<void> {
  skip.value = 0
  await load()
}

async function loadMore(): Promise<void> {
  const current = page.value
  if (!current?.resultId) return
  loading.value = true
  try {
    const more = await api.mongo.getMore(connectionId.value, current.resultId, limit.value)
    page.value = {
      ...current,
      docs: [...current.docs, ...more.docs],
      whole: [...current.whole, ...more.whole],
      fields: mergeFields(current.fields, more.fields),
      truncated: more.truncated,
      resultId: more.resultId
    }
  } catch {
    /* api.invoke showed the error */
  } finally {
    loading.value = false
  }
}

function mergeFields(a: MongoDocumentPage['fields'], b: MongoDocumentPage['fields']) {
  const out = a.map((f) => ({ ...f, types: { ...f.types } }))
  for (const f of b) {
    const hit = out.find((x) => x.path === f.path)
    if (!hit) out.push({ ...f, types: { ...f.types } })
    else {
      hit.count += f.count
      for (const [t, n] of Object.entries(f.types)) hit.types[t] = (hit.types[t] ?? 0) + n
    }
  }
  return out
}

async function cancel(): Promise<void> {
  if (executionId) await api.db.cancel(connectionId.value, executionId).catch(() => false)
}

function prevPage(): void {
  skip.value = Math.max(0, skip.value - limit.value)
  void load()
}
function nextPage(): void {
  skip.value += limit.value
  void load()
}
const canNext = computed(() => {
  const p = page.value
  if (!p) return false
  if (p.total !== null) return skip.value + p.docs.length < p.total
  return p.truncated
})
const rangeText = computed(() => {
  const p = page.value
  if (!p) return ''
  const from = p.docs.length ? skip.value + 1 : 0
  const to = skip.value + p.docs.length
  const total = p.total === null ? '' : ` de ${p.totalExact ? '' : '≈'}${formatNumber(p.total)}`
  return `${formatNumber(from)}–${formatNumber(to)}${total}`
})

function onPending(count: number): void {
  tabs.setDirty(props.tab.id, count > 0)
}

onMounted(() => {
  void loadDetails()
  void load()
})
onBeforeUnmount(() => void closeCursor())

const LIMITS = [50, 100, 200, 500, 1000]
</script>

<template>
  <div class="nd-view collection-view" data-test="collection-view">
    <div class="nd-viewbar" role="toolbar" aria-label="Acciones de la colección">
      <v-btn
        prepend-icon="mdi-refresh"
        size="small"
        :loading="loading"
        data-test="coll-refresh"
        @click="load"
        >Refrescar</v-btn
      >
      <v-btn
        v-if="loading"
        prepend-icon="mdi-stop"
        size="small"
        color="error"
        variant="text"
        @click="cancel"
        >Cancelar</v-btn
      >
      <v-btn
        prepend-icon="mdi-sort-ascending"
        size="small"
        :class="{ 'is-active': showIndexes }"
        :aria-pressed="showIndexes"
        data-test="coll-indexes-toggle"
        @click="showIndexes = !showIndexes"
        >Índices</v-btn
      >
      <v-btn
        prepend-icon="mdi-file-document-edit-outline"
        size="small"
        data-test="coll-design"
        @click="workspace.openCollectionDesigner(connectionId, database, collection)"
        >Diseñar</v-btn
      >
      <span class="nd-viewbar__spacer" />
      <span v-if="page" class="nd-status-pill" data-test="coll-range">{{ rangeText }}</span>
      <span v-if="page" class="text-caption text-medium-emphasis ml-2">{{
        formatDuration(page.durationMs)
      }}</span>
    </div>

    <div class="collection-view__filters" @keydown.enter.prevent="search">
      <v-combobox
        v-model="filter"
        :items="history.filter"
        label="Filtro"
        placeholder="{ estado: 'A', creado: { $gt: ISODate('2026-01-01') } }"
        persistent-placeholder
        density="compact"
        hide-details
        class="nd-mono-input collection-view__filter"
        data-test="coll-filter"
      />
      <v-combobox
        v-model="sort"
        :items="history.sort"
        label="Orden"
        placeholder="{ creado: -1 }"
        persistent-placeholder
        density="compact"
        hide-details
        class="nd-mono-input collection-view__small"
        data-test="coll-sort"
      />
      <v-combobox
        v-model="projection"
        :items="history.projection"
        label="Proyección"
        placeholder="{ nombre: 1 }"
        persistent-placeholder
        density="compact"
        hide-details
        class="nd-mono-input collection-view__small"
        data-test="coll-projection"
      />
      <v-select
        v-model="limit"
        :items="LIMITS"
        label="Límite"
        density="compact"
        hide-details
        class="collection-view__limit"
      />
      <v-btn
        size="small"
        color="primary"
        variant="flat"
        prepend-icon="mdi-magnify"
        data-test="coll-search"
        @click="search"
        >Buscar</v-btn
      >
      <v-btn
        size="small"
        icon="mdi-chevron-left"
        variant="text"
        :disabled="skip === 0 || loading"
        aria-label="Página anterior"
        @click="prevPage"
      />
      <v-btn
        size="small"
        icon="mdi-chevron-right"
        variant="text"
        :disabled="!canNext || loading"
        aria-label="Página siguiente"
        @click="nextPage"
      />
    </div>
    <v-alert
      v-if="error"
      type="error"
      variant="tonal"
      density="compact"
      class="mx-3 mb-2"
      data-test="coll-error"
      >{{ error }}</v-alert
    >

    <div class="nd-viewpanel collection-view__panel">
      <v-progress-linear
        v-if="loading"
        indeterminate
        color="primary"
        height="2"
        class="nd-viewpanel__loader"
      />
      <div class="collection-view__split">
        <DocumentBrowser
          v-model:mode="mode"
          v-model:local-time="localTime"
          class="collection-view__docs"
          :connection-id="connectionId"
          :database="database"
          :collection="collection"
          :page="page"
          :read-only-reason="readOnlyReason"
          :offset="skip"
          :loading="loading"
          @reload="load"
          @load-more="loadMore"
          @pending="onPending"
        />
        <aside v-if="showIndexes" class="collection-view__indexes" data-test="coll-index-panel">
          <div class="collection-view__indexes-head">
            <span class="nd-section-title">Índices</span>
            <v-spacer />
            <v-btn
              size="x-small"
              variant="text"
              prepend-icon="mdi-pencil-outline"
              @click="
                workspace.openCollectionDesigner(connectionId, database, collection, 'indexes')
              "
              >Gestionar</v-btn
            >
          </div>
          <div v-if="!details?.indexes.length" class="text-caption text-medium-emphasis pa-2">
            Sin índices (o la colección es una vista).
          </div>
          <div v-for="ix in details?.indexes ?? []" :key="ix.name" class="collection-view__index">
            <div class="nd-mono">{{ ix.name }}</div>
            <div class="nd-mono text-caption text-medium-emphasis">
              {{ keysSummaryOf(ix.keys) }}
            </div>
            <div class="collection-view__flags">
              <span v-if="ix.unique">único</span>
              <span v-if="ix.sparse">disperso</span>
              <span v-if="ix.hidden">oculto</span>
              <span v-if="ix.expireAfterSeconds !== null">TTL {{ ix.expireAfterSeconds }} s</span>
              <span v-if="ix.partialFilter">parcial</span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  </div>
</template>

<style scoped src="@renderer/components/data/viewChrome.css"></style>
<style scoped>
.collection-view__filters {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px 8px;
}
.collection-view__filter {
  flex: 2 1 280px;
  min-width: 200px;
}
.collection-view__small {
  flex: 1 1 150px;
  min-width: 120px;
}
.collection-view__limit {
  flex: 0 0 96px;
}
.collection-view__filters .nd-mono-input :deep(input) {
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
}
.collection-view__split {
  display: flex;
  height: 100%;
  min-height: 0;
}
.collection-view__docs {
  flex: 1 1 auto;
  min-width: 0;
}
.collection-view__indexes {
  flex: 0 0 250px;
  overflow: auto;
  border-left: 1px solid var(--nd-border);
  background: var(--nd-bg-sunken);
}
.collection-view__indexes-head {
  display: flex;
  align-items: center;
  padding: 6px 8px;
  border-bottom: 1px solid var(--nd-hairline);
}
.collection-view__index {
  padding: 6px 10px;
  border-bottom: 1px solid var(--nd-hairline);
  font-size: var(--nd-fs-dense);
}
.collection-view__flags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}
.collection-view__flags span {
  padding: 0 6px;
  border-radius: var(--nd-radius-pill);
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  background: var(--nd-hover);
}
.is-active {
  color: var(--nd-cyan) !important;
}
</style>
