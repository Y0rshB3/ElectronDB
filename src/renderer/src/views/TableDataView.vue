<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { QueryColumn } from '@shared/types'
import { api } from '@renderer/api'
import EmptyState from '@renderer/components/common/EmptyState.vue'
import ApplyErrorBanner from '@renderer/components/data/ApplyErrorBanner.vue'
import EditableGrid from '@renderer/components/data/EditableGrid.vue'
import RowEditActions from '@renderer/components/data/RowEditActions.vue'
import { isApplyShortcut, useRowEditor } from '@renderer/components/data/useRowEditor'
import { useConfirm } from '@renderer/composables/useConfirm'
import { errorMessage } from '@renderer/composables/useNotify'
import { useSettingsStore } from '@renderer/stores/settings'
import { useTabsStore, type WorkspaceTab } from '@renderer/stores/tabs'
import { formatDuration, formatNumber } from '@renderer/utils/format'

const props = defineProps<{ tab: WorkspaceTab }>()

const settings = useSettingsStore()
const tabs = useTabsStore()
const { ask } = useConfirm()

const columns = ref<QueryColumn[]>([])
const editor = useRowEditor(columns)
const { rows, selected, active, applying, applyError, pending, dirty } = editor
const primaryKey = ref<string[]>([])
const total = ref<number | null>(null)
const durationMs = ref<number | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)

const page = ref(1)
const sort = ref<{ column: string; direction: 'ASC' | 'DESC' } | null>(null)
const whereInput = ref('')
const appliedWhere = ref('')

const pageSize = computed(() => settings.rowLimit)
const pageCount = computed(() =>
  total.value === null ? null : Math.max(1, Math.ceil(total.value / pageSize.value))
)
const loadedRows = computed(() => rows.value.filter((r) => r.original).length)
const hasNext = computed(() =>
  pageCount.value === null ? loadedRows.value >= pageSize.value : page.value < pageCount.value
)
const noPrimaryKey = computed(() => columns.value.length > 0 && primaryKey.value.length === 0)

watch(dirty, (value) => tabs.setDirty(props.tab.id, value), { immediate: true })

async function discardGuard(): Promise<boolean> {
  if (!dirty.value) return true
  return ask({
    title: 'Cambios sin aplicar',
    message: `Hay ${pending.value} fila(s) con cambios pendientes. ¿Descartarlos y continuar?`,
    confirmText: 'Descartar cambios',
    color: 'warning'
  })
}

async function load(): Promise<void> {
  if (!props.tab.connectionId || !props.tab.schema || !props.tab.objectName) {
    loadError.value = 'La pestaña no tiene conexión, esquema o tabla asociados'
    return
  }
  loading.value = true
  loadError.value = null
  try {
    const result = await api.db.tableData(props.tab.connectionId, {
      schema: props.tab.schema,
      table: props.tab.objectName,
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
      orderBy: sort.value,
      where: appliedWhere.value.trim() || null
    })
    columns.value = result.columns
    editor.reset(result.rows)
    primaryKey.value = result.primaryKey
    total.value = result.total
    durationMs.value = result.durationMs
  } catch (err) {
    loadError.value = errorMessage(err)
  } finally {
    loading.value = false
  }
}

async function reload(): Promise<void> {
  if (await discardGuard()) await load()
}

async function goToPage(target: number): Promise<void> {
  if (target < 1 || target === page.value) return
  if (!(await discardGuard())) return
  page.value = target
  await load()
}

async function toggleSort(column: string): Promise<void> {
  if (!(await discardGuard())) return
  if (sort.value?.column !== column) sort.value = { column, direction: 'ASC' }
  else if (sort.value.direction === 'ASC') sort.value = { column, direction: 'DESC' }
  else sort.value = null
  page.value = 1
  await load()
}

async function applyFilter(): Promise<void> {
  if (!(await discardGuard())) return
  appliedWhere.value = whereInput.value
  page.value = 1
  await load()
}

async function clearFilter(): Promise<void> {
  whereInput.value = ''
  if (appliedWhere.value) await applyFilter()
}

async function applyChanges(): Promise<void> {
  const { connectionId, schema, objectName } = props.tab
  if (!connectionId || !schema || !objectName) return
  const applied = await editor.apply(
    { connectionId, schema, table: objectName },
    columns.value,
    primaryKey.value
  )
  if (applied) await load()
}

const grid = ref<InstanceType<typeof EditableGrid> | null>(null)

/** "Ir a la fila": selects the row (and cell) whose change failed. */
function locateApplyError(): void {
  const failure = applyError.value
  if (!failure?.uid) return
  selected.value = [failure.uid]
  active.value = { uid: failure.uid, col: failure.col ?? 0 }
  grid.value?.revealError()
}

function onKeydown(event: KeyboardEvent): void {
  if (isApplyShortcut(event)) {
    event.preventDefault()
    void applyChanges()
  }
}

onMounted(load)

defineExpose({ rows, applyChanges, load })
</script>

<template>
  <div class="nd-view table-data" @keydown="onKeydown">
    <div class="nd-viewbar nd-viewbar--rowedit" role="toolbar" aria-label="Acciones de datos">
      <v-btn
        prepend-icon="mdi-refresh"
        size="small"
        :loading="loading"
        data-test="refresh"
        @click="reload"
        >Refrescar</v-btn
      >
      <span class="nd-viewbar__sep" aria-hidden="true" />
      <RowEditActions
        :can-add="!loading && columns.length > 0"
        :can-delete="selected.length > 0"
        :can-set-null="!!active"
        :pending="pending"
        :applying="applying"
        @add="editor.addRow"
        @delete="editor.deleteSelected"
        @null="editor.setNull"
        @discard="editor.discard"
        @apply="applyChanges"
      />
    </div>

    <div class="nd-viewpanel">
      <div class="table-data__filter">
        <v-text-field
          v-model="whereInput"
          density="compact"
          prefix="WHERE"
          prepend-inner-icon="mdi-filter-variant"
          placeholder="p. ej. id > 10 AND estado = 'activo'"
          aria-label="Filtro WHERE"
          clearable
          hide-details
          class="table-data__where"
          :class="{ 'is-applied': !!appliedWhere }"
          data-test="where"
          @keydown.enter="applyFilter"
          @click:clear="clearFilter"
        />
        <v-btn size="small" variant="tonal" data-test="apply-filter" @click="applyFilter"
          >Filtrar</v-btn
        >
      </div>

      <ApplyErrorBanner
        v-if="applyError"
        :message="applyError.message"
        :can-locate="!!applyError.uid"
        @locate="locateApplyError"
        @close="applyError = null"
      />

      <div v-if="noPrimaryKey" class="table-data__notice" role="note">
        <v-icon icon="mdi-key-remove" size="14" />
        La tabla no tiene clave primaria: las filas se identifican por todos sus valores.
      </div>

      <div class="table-data__grid">
        <v-progress-linear
          v-if="loading"
          indeterminate
          color="primary"
          height="2"
          class="nd-viewpanel__loader"
        />
        <EmptyState
          v-if="loadError"
          icon="mdi-alert-circle-outline"
          title="No se pudieron cargar los datos"
          :description="loadError"
        >
          <v-btn variant="tonal" size="small" prepend-icon="mdi-refresh" @click="load"
            >Reintentar</v-btn
          >
        </EmptyState>
        <EditableGrid
          v-else-if="columns.length"
          ref="grid"
          v-model:selected="selected"
          v-model:active="active"
          :columns="columns"
          :rows="rows"
          :primary-key="primaryKey"
          :sort="sort"
          :offset="(page - 1) * pageSize"
          :error-row="applyError?.uid ?? null"
          :error-col="applyError?.col ?? null"
          @sort="toggleSort"
          @edit="editor.onEdit"
        />
        <EmptyState v-else-if="!loading" icon="mdi-table-off" title="Sin datos" />
      </div>

      <div class="table-data__footer" data-test="footer">
        <span class="table-data__stats nd-ellipsis">
          {{ formatNumber(loadedRows) }} fila(s) en esta página
          <template v-if="total !== null"> · {{ formatNumber(total) }} en total</template>
          <template v-if="durationMs !== null"> · {{ formatDuration(durationMs) }}</template>
          <template v-if="appliedWhere"> · filtrado</template>
        </span>
        <span class="nd-viewbar__spacer" />
        <div class="table-data__pager" role="navigation" aria-label="Paginación">
          <v-btn
            icon="mdi-page-first"
            size="x-small"
            aria-label="Primera página"
            :disabled="page <= 1 || loading"
            @click="goToPage(1)"
          />
          <v-btn
            icon="mdi-chevron-left"
            size="x-small"
            aria-label="Página anterior"
            :disabled="page <= 1 || loading"
            @click="goToPage(page - 1)"
          />
          <span class="table-data__page"
            >Página {{ page
            }}<template v-if="pageCount !== null"> de {{ pageCount }}</template></span
          >
          <v-btn
            icon="mdi-chevron-right"
            size="x-small"
            aria-label="Página siguiente"
            :disabled="!hasNext || loading"
            data-test="next-page"
            @click="goToPage(page + 1)"
          />
          <v-btn
            icon="mdi-page-last"
            size="x-small"
            aria-label="Última página"
            :disabled="pageCount === null || page >= pageCount || loading"
            @click="goToPage(pageCount ?? page)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped src="../components/data/viewChrome.css"></style>
<style scoped>
.table-data__filter {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding: 8px 10px;
  border-bottom: 1px solid var(--nd-hairline);
}
.table-data__where {
  flex: 1 1 auto;
}
.table-data__where :deep(.v-text-field__prefix) {
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  font-weight: 600;
  color: var(--nd-violet);
  opacity: 1;
  padding-inline-end: 8px;
}
.table-data__where :deep(input) {
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
}
.table-data__where.is-applied :deep(.v-field__prepend-inner > .v-icon) {
  color: var(--nd-accent);
  opacity: 1;
}
.table-data__notice {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding: 6px 12px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-info);
  background: var(--nd-info-soft);
  border-bottom: 1px solid var(--nd-hairline);
}
.table-data__grid {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}
.table-data__footer {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  min-height: 34px;
  padding: 0 6px 0 12px;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  font-variant-numeric: tabular-nums;
  color: var(--nd-text-2);
  border-top: 1px solid var(--nd-border);
  background: var(--nd-bg-raised);
}
.table-data__pager {
  display: flex;
  align-items: center;
  gap: 2px;
}
.table-data__page {
  margin: 0 8px;
  color: var(--nd-text);
  white-space: nowrap;
}
</style>
