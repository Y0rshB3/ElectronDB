<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { BackupFile, JobRun } from '@shared/types'
import {
  groupBackupPackages,
  packageDate,
  packageRestoreSource,
  type BackupPackage
} from '@shared/backupPackages'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useBackupsStore } from '@renderer/stores/backups'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useJobsStore } from '@renderer/stores/jobs'
import type { WorkspaceTab } from '@renderer/stores/tabs'
import { useUiStore } from '@renderer/stores/ui'
import { formatBytes, formatDate, formatNumber } from '@renderer/utils/format'
import EmptyState from '@renderer/components/common/EmptyState.vue'
import BackupDetailsPanel from '@renderer/components/backups/BackupDetailsPanel.vue'
import SourcePill from '@renderer/components/backups/SourcePill.vue'
import { revealInFinder } from '@renderer/components/backups/reveal'
import GroupAutoOpen, { type TableGroup } from '@renderer/components/backups/GroupAutoOpen'
import RollbackDialog from '@renderer/components/automation/RollbackDialog.vue'
import RunLogPanel from '@renderer/components/automation/RunLogPanel.vue'
import type { RollbackDialogSource } from '@renderer/components/automation/rollback'
import {
  NAVICAT_DELETE_TOOLTIP,
  backupConnections,
  canDeleteBackup,
  findLocalConnection
} from '@renderer/components/backups/backupHelpers'

const props = defineProps<{ tab: WorkspaceTab }>()

const backups = useBackupsStore()
const connections = useConnectionsStore()
const jobs = useJobsStore()
const ui = useUiStore()
const notify = useNotify()

const schemaFilter = ref<string | null>(props.tab.schema ?? null)
const search = ref('')
const selectedPath = ref<string | null>(null)
const error = ref('')
const deleting = ref(false)

const connectionId = computed(() => props.tab.connectionId ?? null)
const connection = computed(() =>
  connectionId.value ? connections.get(connectionId.value) : undefined
)
const allFiles = computed(() =>
  connectionId.value ? backups.listOf(connectionId.value, null) : []
)
const loading = computed(() =>
  connectionId.value ? backups.isLoading(connectionId.value, null) : false
)
const files = computed(() =>
  schemaFilter.value
    ? allFiles.value.filter((f) => f.schema === schemaFilter.value)
    : allFiles.value
)
const schemaOptions = computed(() => {
  const set = new Set(allFiles.value.map((f) => f.schema).filter((s): s is string => !!s))
  if (props.tab.schema) set.add(props.tab.schema)
  return [...set].sort((a, b) => a.localeCompare(b, 'es'))
})
const selected = computed<BackupFile | null>(
  () => files.value.find((f) => f.path === selectedPath.value) ?? null
)
/** PostgreSQL: .vqb only, no .sql export and no packages (automation is MySQL-only). */
const isPg = computed(() => connection.value?.engine === 'postgresql')
const localConnection = computed(() =>
  findLocalConnection(
    backupConnections(connections.sorted).filter((c) => (c.engine === 'postgresql') === isPg.value)
  )
)

/* ---------- Packages (files one batch produced together) ---------- */

const GROUP_KEY = 'electrondb.backups.groupByPackage'
function readGroupPreference(): boolean {
  try {
    return localStorage.getItem(GROUP_KEY) !== '0'
  } catch {
    return true
  }
}
/** «Agrupar por paquete», remembered per user (default on). */
const groupByPackage = ref(readGroupPreference())
watch(groupByPackage, (value) => {
  try {
    localStorage.setItem(GROUP_KEY, value ? '1' : '0')
  } catch {
    /* storage unavailable: the choice lasts for this session */
  }
})
/** Packages of every listed file (the schema filter does not split them). */
const packages = computed(() => groupBackupPackages(allFiles.value))
type BackupRow = BackupFile & { groupKey: string }
/**
 * Group of each row: its package, or a group of its own for single files (no
 * header, opened automatically). Keys start with the newest date so groups
 * sort newest first with packages and single files interleaved.
 */
const packageByKey = computed(() => {
  const map = new Map<string, BackupPackage>()
  for (const pkg of packages.value.packages) map.set(`${pkg.lastAt}|${pkg.id}`, pkg)
  return map
})
const rows = computed<BackupRow[]>(() =>
  files.value.map((f) => {
    const pkg = packages.value.byPath.get(f.path)
    return { ...f, groupKey: pkg ? `${pkg.lastAt}|${pkg.id}` : `${f.createdAt}|file:${f.path}` }
  })
)
const groupBy = computed(() =>
  groupByPackage.value ? [{ key: 'groupKey', order: 'desc' as const }] : []
)
const packageOfGroup = (group: { value: unknown }): BackupPackage | null =>
  packageByKey.value.get(String(group.value)) ?? null
const isSingleGroup = (group: TableGroup): boolean => !packageOfGroup(group)
/** « · hasta 23:20» when the package spans more than one minute. */
function untilText(pkg: BackupPackage): string {
  const first = packageDate(pkg.firstAt)
  const last = packageDate(pkg.lastAt)
  if (first === last) return ''
  return ` · hasta ${first.slice(0, 10) === last.slice(0, 10) ? last.slice(11) : last}`
}

/** Files checked for «Restaurar paquete en Local». */
const checked = ref<string[]>([])
const checkedSet = computed(() => new Set(checked.value))
watch(allFiles, (list) => {
  // Drop checks of files that are no longer listed (deleted, folder changed).
  const present = new Set(list.map((f) => f.path))
  if (checked.value.some((p) => !present.has(p)))
    checked.value = checked.value.filter((p) => present.has(p))
})

/** Visible files of a package group (search and schema filter applied). */
function groupPaths(group: { items: readonly unknown[] }): string[] {
  return group.items
    .map((i) => (i as { raw?: BackupRow }).raw?.path)
    .filter((p): p is string => !!p)
}
function groupState(group: { items: readonly unknown[] }): 'all' | 'some' | 'none' {
  const paths = groupPaths(group)
  const n = paths.filter((p) => checkedSet.value.has(p)).length
  return n === 0 ? 'none' : n === paths.length ? 'all' : 'some'
}
/** Checks every visible file of the package (or unchecks them when all were checked). */
function selectPackage(group: { items: readonly unknown[] }, value?: boolean | null): void {
  const paths = groupPaths(group)
  const on = value ?? groupState(group) !== 'all'
  const set = new Set(checked.value)
  for (const p of paths) {
    if (on) set.add(p)
    else set.delete(p)
  }
  checked.value = [...set]
}

/**
 * What «Restaurar paquete en Local» restores: the checked files, or else the
 * package of the selected row.
 */
const packageSelection = computed<BackupFile[]>(() => {
  if (checked.value.length) return allFiles.value.filter((f) => checkedSet.value.has(f.path))
  const pkg = selected.value ? packages.value.byPath.get(selected.value.path) : null
  return pkg ? pkg.files : []
})
const packageRestoreTip = computed(() => {
  const n = packageSelection.value.length
  const where = localConnection.value?.name ?? 'Local'
  if (!n)
    return `Marca las copias de un paquete (o pulsa la cabecera del paquete) para restaurarlas todas juntas en ${where}.`
  return `Restaura en ${where} ${n === 1 ? 'la copia marcada' : `las ${n} copias`} en un solo paso: cada base de datos se reemplaza, con copia previa opcional.`
})

const rollbackOpen = ref(false)
const rollbackSource = ref<RollbackDialogSource | null>(null)
const logRunId = ref<string | null>(null)
const logOpen = ref(false)
const logRun = computed<JobRun | null>(() =>
  logRunId.value ? (jobs.runs.find((r) => r.id === logRunId.value) ?? null) : null
)
const isLocalSource = computed(() => connection.value?.environment === 'local')

// Name takes the remaining width and truncates; the rest never wrap. With the details
// drawer open the schema and label columns are dropped (the drawer shows both) so names
// stay readable.
const headers = computed(() => [
  // Vuetify adds a «Group» column when grouping: keep it empty and zero-width.
  ...(groupByPackage.value
    ? [{ title: '', key: 'data-table-group', width: 0, sortable: false }]
    : []),
  {
    title: 'Nombre',
    key: 'fileName',
    minWidth: '180px',
    cellProps: { class: 'backups-view__name-cell' }
  },
  ...(selected.value ? [] : [{ title: 'Esquema', key: 'schema', width: 150, nowrap: true }]),
  { title: 'Tamaño', key: 'sizeBytes', align: 'end' as const, width: 92, nowrap: true },
  { title: 'Fecha', key: 'createdAt', width: 168, nowrap: true },
  { title: 'Origen', key: 'source', width: 104, nowrap: true },
  ...(selected.value
    ? []
    : [
        {
          title: 'Etiqueta',
          key: 'label',
          width: 130,
          cellProps: { class: 'backups-view__label-cell' }
        }
      ])
])
/** Most recent copy in the current list, highlighted in the table. */
const newestPath = computed(() => {
  let best: BackupFile | null = null
  for (const f of files.value) if (!best || f.createdAt > best.createdAt) best = f
  return best?.path ?? null
})
const sortBy = ref([{ key: 'createdAt', order: 'desc' as const }])
const PAGE_SIZE = 100
const page = ref(1)
watch([search, schemaFilter], () => (page.value = 1))

async function reload(): Promise<void> {
  if (!connectionId.value) return
  error.value = ''
  try {
    await backups.load(connectionId.value, null)
  } catch (err) {
    error.value = errorMessage(err)
  }
}

function onRowClick(_e: unknown, row: { item: BackupFile }): void {
  selectedPath.value = row.item.path === selectedPath.value ? null : row.item.path
}

function newBackup(): void {
  if (!connectionId.value) return
  ui.openBackupDialog(connectionId.value, schemaFilter.value ?? selected.value?.schema ?? null)
}

/** «Exportar a .sql…»: the same dialog on the .sql format (dumps for other managers). */
function exportSql(): void {
  if (!connectionId.value) return
  ui.openBackupDialog(connectionId.value, schemaFilter.value ?? selected.value?.schema ?? null, {
    format: 'sql'
  })
}

function restore(): void {
  if (selected.value) ui.openRestoreDialog(selected.value, connectionId.value)
}

const NO_LOCAL_WARNING =
  'No hay ninguna conexión marcada como «Local». Edita una conexión y cambia su entorno a Local.'

function restoreToLocal(): void {
  if (!selected.value) return
  if (!localConnection.value) {
    notify.warning(NO_LOCAL_WARNING)
    return
  }
  ui.openRestoreDialog(selected.value, localConnection.value.id)
}

/** Opens the «Restaurar todo» dialog with the selected package's databases pre-checked. */
function restorePackageToLocal(): void {
  if (!connectionId.value) return
  if (!localConnection.value) {
    notify.warning(NO_LOCAL_WARNING)
    return
  }
  const source = packageRestoreSource(packageSelection.value, packages.value)
  if (!source) return
  rollbackSource.value =
    source.kind === 'run'
      ? { kind: 'run', runId: source.runId, taskIds: source.taskIds }
      : {
          kind: 'files',
          backupPaths: source.backupPaths,
          sourceConnectionId: connectionId.value,
          title: source.title
        }
  rollbackOpen.value = true
}

/** The restore is a run of its own: show its live log. */
function onRollbackStarted(run: JobRun): void {
  checked.value = []
  logRunId.value = run.id
  logOpen.value = true
}

async function remove(): Promise<void> {
  const file = selected.value
  if (!file || !canDeleteBackup(file)) return
  const ok = await ui.ask({
    title: 'Eliminar copia de seguridad',
    message: `Se eliminará el archivo de copia de seguridad de forma permanente.`,
    details: file.path,
    confirmText: 'Eliminar',
    color: 'error'
  })
  if (!ok) return
  deleting.value = true
  try {
    await backups.remove(file)
    selectedPath.value = null
    notify.success('Copia de seguridad eliminada')
  } catch {
    // invoke() already reported the error to the user.
  } finally {
    deleting.value = false
  }
}

function showInFinder(): void {
  revealInFinder(selected.value?.path)
}

onMounted(reload)

// Reload when another component (e.g. BackupDialog) invalidates this connection's lists.
watch(
  () => (connectionId.value ? backups.lists[`${connectionId.value}:*`] : null),
  (list) => {
    if (list === undefined && !loading.value) void reload()
  }
)
watch(connectionId, () => {
  checked.value = []
  void reload()
})
</script>

<template>
  <div class="backups-view d-flex flex-column" data-test="backups-view">
    <v-toolbar
      density="compact"
      class="nd-viewbar"
      role="toolbar"
      aria-label="Acciones de copias de seguridad"
    >
      <v-btn
        size="small"
        prepend-icon="mdi-archive-plus-outline"
        color="primary"
        variant="flat"
        :disabled="!connectionId"
        data-test="backups-new"
        @click="newBackup"
        >Nueva copia</v-btn
      >
      <v-btn
        v-if="!isPg"
        size="small"
        prepend-icon="mdi-file-export-outline"
        variant="tonal"
        :disabled="!connectionId"
        title="Archivo .sql que el cliente mysql y otros gestores pueden importar"
        data-test="backups-export-sql"
        @click="exportSql"
        >Exportar a .sql…</v-btn
      >
      <span class="nd-viewbar__sep" aria-hidden="true" />
      <v-btn
        size="small"
        prepend-icon="mdi-backup-restore"
        :disabled="!selected"
        data-test="backups-restore"
        @click="restore"
        >Restaurar</v-btn
      >
      <v-btn
        size="small"
        prepend-icon="mdi-laptop"
        :disabled="!selected"
        :title="localConnection ? `Restaurar en ${localConnection.name}` : 'No hay conexión Local'"
        data-test="backups-restore-local"
        @click="restoreToLocal"
      >
        Restaurar en Local
      </v-btn>
      <v-tooltip v-if="!isPg" :text="packageRestoreTip" location="bottom" max-width="320">
        <template #activator="{ props: tipProps }">
          <span v-bind="tipProps" class="backups-view__tip-wrap">
            <v-btn
              size="small"
              prepend-icon="mdi-package-variant-closed"
              :disabled="!packageSelection.length"
              data-test="backups-restore-package"
              @click="restorePackageToLocal"
            >
              Restaurar paquete en Local
              <span
                v-if="packageSelection.length"
                class="backups-view__count"
                data-test="backups-package-count"
                >{{ packageSelection.length }}</span
              >
            </v-btn>
          </span>
        </template>
      </v-tooltip>
      <v-btn
        icon="mdi-folder-open-outline"
        size="small"
        variant="text"
        :disabled="!selected"
        aria-label="Mostrar en Finder"
        title="Mostrar en Finder"
        @click="showInFinder"
      />
      <v-tooltip
        v-if="selected && !canDeleteBackup(selected)"
        :text="NAVICAT_DELETE_TOOLTIP"
        location="bottom"
      >
        <template #activator="{ props: tooltipProps }">
          <span v-bind="tooltipProps">
            <v-btn
              size="small"
              prepend-icon="mdi-delete-outline"
              disabled
              data-test="backups-delete"
              >Eliminar</v-btn
            >
          </span>
        </template>
      </v-tooltip>
      <v-btn
        v-else
        size="small"
        prepend-icon="mdi-delete-outline"
        :disabled="!selected"
        :loading="deleting"
        class="backups-view__delete"
        data-test="backups-delete"
        @click="remove"
      >
        Eliminar
      </v-btn>
      <v-spacer />
      <v-select
        v-model="schemaFilter"
        :items="schemaOptions"
        label="Esquema"
        clearable
        hide-details
        density="compact"
        class="backups-view__filter"
        placeholder="Todos"
      />
      <v-text-field
        v-model="search"
        prepend-inner-icon="mdi-magnify"
        placeholder="Buscar"
        hide-details
        density="compact"
        class="backups-view__filter"
        aria-label="Buscar copias"
      />
      <v-btn
        icon="mdi-refresh"
        size="small"
        variant="text"
        :loading="loading"
        aria-label="Actualizar"
        title="Actualizar"
        data-test="backups-refresh"
        @click="reload"
      />
    </v-toolbar>

    <v-alert
      v-if="connection && !isLocalSource"
      type="info"
      icon="mdi-lifebuoy"
      class="backups-view__notice"
      closable
    >
      <strong>Rollback a Local:</strong> 1) «Nueva copia» crea una copia de «{{ connection.name }}»;
      2) selecciónala y pulsa «Restaurar en Local» para cargarla en
      {{ localConnection?.name ?? 'tu conexión Local' }}. Para un lote entero (todas las copias de
      una automatización), pulsa la cabecera del paquete y «Restaurar paquete en Local».
    </v-alert>
    <v-alert v-if="error" type="error" class="backups-view__notice">{{ error }}</v-alert>

    <div class="backups-view__body d-flex">
      <div class="backups-view__table">
        <EmptyState
          v-if="!connectionId"
          icon="mdi-archive-off-outline"
          title="Sin conexión"
          description="Abre esta vista desde una conexión."
        />
        <EmptyState
          v-else-if="!loading && !files.length"
          icon="mdi-archive-outline"
          title="No hay copias de seguridad"
          :description="`No se encontraron copias (${isPg ? '.vqb' : '.vqb o .nb3'}) en ${connection?.backupDir || 'la carpeta de copias'}${schemaFilter ? ` para ${schemaFilter}` : ''}.`"
        >
          <v-btn
            color="primary"
            variant="flat"
            prepend-icon="mdi-archive-plus-outline"
            @click="newBackup"
            >Nueva copia</v-btn
          >
        </EmptyState>
        <v-data-table
          v-else
          v-model:sort-by="sortBy"
          v-model:page="page"
          v-model="checked"
          :headers="headers"
          :items="rows"
          :group-by="groupBy"
          :search="search"
          :loading="loading"
          show-select
          item-value="path"
          density="compact"
          :items-per-page="PAGE_SIZE"
          hover
          fixed-header
          class="backups-view__grid"
          loading-text="Buscando copias…"
          no-data-text="Sin resultados"
          :row-props="
            ({ item }) => ({
              class: item.path === selectedPath ? 'bg-surface-variant' : '',
              'data-test': 'backup-row'
            })
          "
          @click:row="onRowClick"
        >
          <template #top="{ groupedItems, isGroupOpen, toggleGroup }">
            <GroupAutoOpen
              :groups="groupedItems"
              :is-group-open="isGroupOpen"
              :toggle-group="toggleGroup"
              :should-open="isSingleGroup"
            />
          </template>
          <template #group-header="{ item, columns, isGroupOpen, toggleGroup }">
            <tr
              v-if="packageOfGroup(item)"
              class="backups-pkg"
              :class="{ 'backups-pkg--checked': groupState(item) !== 'none' }"
              tabindex="0"
              role="row"
              :aria-label="`Paquete ${packageOfGroup(item)!.title}: pulsa para seleccionar sus copias`"
              data-test="backup-package"
              @click="selectPackage(item)"
              @keydown.enter.self.prevent="selectPackage(item)"
              @keydown.space.self.prevent="selectPackage(item)"
            >
              <td class="backups-pkg__select">
                <v-checkbox-btn
                  :model-value="groupState(item) === 'all'"
                  :indeterminate="groupState(item) === 'some'"
                  density="compact"
                  :aria-label="`Seleccionar paquete ${packageOfGroup(item)!.title}`"
                  data-test="backup-package-check"
                  @click.stop
                  @update:model-value="selectPackage(item, $event)"
                />
              </td>
              <td :colspan="columns.length - 1" class="backups-pkg__cell">
                <div class="backups-pkg__inner">
                  <v-btn
                    :icon="isGroupOpen(item) ? 'mdi-chevron-down' : 'mdi-chevron-right'"
                    size="x-small"
                    variant="text"
                    :aria-label="isGroupOpen(item) ? 'Contraer paquete' : 'Expandir paquete'"
                    :aria-expanded="isGroupOpen(item)"
                    data-test="backup-package-toggle"
                    @click.stop="toggleGroup(item)"
                  />
                  <v-icon
                    :icon="
                      packageOfGroup(item)!.kind === 'run'
                        ? 'mdi-robot-outline'
                        : 'mdi-package-variant-closed'
                    "
                    size="16"
                    class="backups-pkg__icon"
                    aria-hidden="true"
                  />
                  <span class="backups-pkg__title nd-ellipsis" data-test="backup-package-title">{{
                    packageOfGroup(item)!.title
                  }}</span>
                  <span class="backups-pkg__meta nd-mono" data-test="backup-package-count"
                    >{{ item.items.length }} {{ item.items.length === 1 ? 'copia' : 'copias' }} ·
                    {{ formatBytes(packageOfGroup(item)!.sizeBytes)
                    }}{{ untilText(packageOfGroup(item)!) }}</span
                  >
                  <span
                    class="nd-pill backups-pkg__kind"
                    :class="packageOfGroup(item)!.kind === 'run' ? 'nd-pill--info' : ''"
                    :title="
                      packageOfGroup(item)!.kind === 'run'
                        ? 'Copias hechas por una ejecución de una tarea de automatización'
                        : 'Copias con la misma etiqueta hechas una tras otra (menos de 10 min entre ellas)'
                    "
                    >{{ packageOfGroup(item)!.kind === 'run' ? 'Automatización' : 'Lote' }}</span
                  >
                </div>
              </td>
            </tr>
          </template>
          <template #[`item.fileName`]="{ item }">
            <div class="backups-view__name">
              <v-icon
                :icon="item.encrypted ? 'mdi-lock-outline' : 'mdi-archive-outline'"
                size="16"
                class="backups-view__file-icon"
                :class="{ 'backups-view__file-icon--locked': item.encrypted }"
                :aria-label="item.encrypted ? 'Copia cifrada con contraseña' : undefined"
                :aria-hidden="item.encrypted ? undefined : 'true'"
                :title="item.encrypted ? 'Cifrada con contraseña' : undefined"
                data-test="backup-row-icon"
              />
              <span class="nd-ellipsis" :title="item.path">{{ item.fileName }}</span>
              <span
                v-if="item.path === newestPath"
                class="backups-view__newest"
                title="Copia más reciente"
                >Última</span
              >
            </div>
          </template>
          <template #[`item.schema`]="{ item }">
            <span class="nd-mono backups-view__schema">{{ item.schema ?? '—' }}</span>
          </template>
          <template #[`item.sizeBytes`]="{ item }">
            <span class="nd-num">{{ formatBytes(item.sizeBytes) }}</span>
          </template>
          <template #[`item.createdAt`]="{ item }">
            <span class="nd-mono backups-view__date">{{ formatDate(item.createdAt) }}</span>
          </template>
          <template #[`item.source`]="{ item }">
            <SourcePill :source="item.source" />
          </template>
          <template #[`item.label`]="{ item }">
            <span v-if="item.label" class="nd-ellipsis backups-view__label" :title="item.label">{{
              item.label
            }}</span>
          </template>
          <template #bottom="{ items, pageCount }">
            <div class="backups-view__footer" data-test="backups-footer">
              <span class="nd-ellipsis">
                {{ formatNumber(items.length) }} copia(s) en esta página ·
                {{ formatNumber(files.length) }} en total
                <template v-if="search"> · filtrado</template>
              </span>
              <span class="backups-view__footer-spacer" />
              <v-switch
                v-model="groupByPackage"
                label="Agrupar por paquete"
                color="primary"
                density="compact"
                hide-details
                class="backups-view__group-toggle"
                data-test="backups-group-toggle"
              />
              <div
                v-if="pageCount > 1"
                class="backups-view__pager"
                role="navigation"
                aria-label="Paginación"
              >
                <v-btn
                  icon="mdi-page-first"
                  size="x-small"
                  variant="text"
                  aria-label="Primera página"
                  :disabled="page <= 1"
                  @click="page = 1"
                />
                <v-btn
                  icon="mdi-chevron-left"
                  size="x-small"
                  variant="text"
                  aria-label="Página anterior"
                  :disabled="page <= 1"
                  @click="page--"
                />
                <span class="backups-view__page">Página {{ page }} de {{ pageCount }}</span>
                <v-btn
                  icon="mdi-chevron-right"
                  size="x-small"
                  variant="text"
                  aria-label="Página siguiente"
                  :disabled="page >= pageCount"
                  @click="page++"
                />
                <v-btn
                  icon="mdi-page-last"
                  size="x-small"
                  variant="text"
                  aria-label="Última página"
                  :disabled="page >= pageCount"
                  @click="page = pageCount"
                />
              </div>
            </div>
          </template>
        </v-data-table>
      </div>
      <div v-if="selected" class="backups-view__details">
        <BackupDetailsPanel :file="selected" @close="selectedPath = null" />
      </div>
    </div>

    <RollbackDialog v-model="rollbackOpen" :source="rollbackSource" @started="onRollbackStarted" />
    <v-dialog v-model="logOpen" max-width="980" scrollable>
      <v-card class="backups-view__log-card">
        <div class="backups-view__log-panel">
          <RunLogPanel :run="logRun" @close="logOpen = false" />
        </div>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.backups-view__tip-wrap {
  display: inline-flex;
  flex: none;
}
.backups-view__count {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: var(--nd-radius-pill);
  font-size: 10.5px;
  font-weight: 600;
  background: var(--nd-accent-gradient-soft);
}
.backups-view__group-toggle {
  flex: none;
  margin-right: 6px;
}
.backups-view__group-toggle :deep(.v-selection-control) {
  min-height: 28px;
}
.backups-view__group-toggle :deep(.v-label) {
  font-family: var(--nd-font-ui);
  font-size: var(--nd-fs-xs);
  white-space: nowrap;
}
.backups-pkg__select {
  width: 1px;
  padding: 0 !important;
  border-bottom: 1px solid var(--nd-border) !important;
}
.backups-pkg__select :deep(.v-selection-control) {
  justify-content: center;
}
.backups-pkg {
  cursor: pointer;
  background: var(--nd-bg-raised);
}
.backups-pkg:hover,
.backups-pkg:focus-visible {
  background: var(--nd-hover);
  outline: none;
}
.backups-pkg--checked {
  background: rgba(var(--nd-accent-rgb), 0.08);
}
.backups-pkg__cell {
  padding: 0 8px 0 4px !important;
  border-bottom: 1px solid var(--nd-border) !important;
}
.backups-pkg__inner {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 36px;
}
.backups-pkg__inner :deep(.v-selection-control) {
  flex: none;
}
.backups-pkg__icon {
  flex: none;
  color: var(--nd-accent);
}
.backups-pkg__title {
  font-weight: 600;
  color: var(--nd-text);
}
.backups-pkg__meta {
  flex: none;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  white-space: nowrap;
}
.backups-pkg__kind {
  flex: none;
  height: 17px;
  font-size: 10.5px;
}
.backups-view__log-panel {
  height: min(70vh, 640px);
}
.backups-view {
  height: 100%;
  min-height: 0;
}
.nd-viewbar {
  flex: 0 0 auto;
  padding: 0 12px;
  border-bottom: 1px solid var(--nd-border);
  overflow-x: auto;
}
.nd-viewbar :deep(.v-toolbar__content) {
  gap: 2px;
  height: 46px !important;
}
.nd-viewbar :deep(.v-toolbar__content > .v-btn) {
  flex: none;
}
/* Destructive action: neutral until hovered (red only on hover). */
.backups-view__delete.v-btn:not(.v-btn--disabled):hover,
.backups-view__delete.v-btn:not(.v-btn--disabled):focus-visible {
  color: var(--nd-error) !important;
  background: var(--nd-error-soft);
}
.nd-viewbar__sep {
  flex: none;
  width: 1px;
  height: 20px;
  margin: 0 6px;
  background: var(--nd-border-strong);
}
.backups-view__filter {
  flex: 0 1 160px;
  min-width: 96px;
  margin-left: 4px;
}
.backups-view__filter :deep(.v-field__input) {
  min-height: 30px;
  padding-top: 4px;
  padding-bottom: 4px;
  font-size: var(--nd-fs-dense);
}
.backups-view__filter :deep(.v-field__append-inner),
.backups-view__filter :deep(.v-field__clearable),
.backups-view__filter :deep(.v-field__prepend-inner) {
  padding-top: 0;
  align-items: center;
}
.backups-view__notice {
  margin: 10px 12px 0;
  flex: 0 0 auto;
}
.backups-view__body {
  flex: 1;
  min-height: 0;
}
.backups-view__table {
  flex: 1;
  min-width: 0;
  overflow: auto;
}
.backups-view__grid {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.backups-view__grid :deep(.v-table__wrapper) {
  flex: 1 1 auto;
}
.backups-view__footer {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  min-height: 32px;
  padding: 0 6px 0 12px;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  font-variant-numeric: tabular-nums;
  color: var(--nd-text-2);
  border-top: 1px solid var(--nd-border);
  background: var(--nd-bg-raised);
}
.backups-view__footer-spacer {
  flex: 1 1 auto;
}
.backups-view__pager {
  display: flex;
  align-items: center;
  gap: 2px;
}
.backups-view__page {
  margin: 0 8px;
  color: var(--nd-text);
  white-space: nowrap;
}
.backups-view__grid :deep(.backups-view__name-cell) {
  max-width: 0;
  width: 100%;
}
.backups-view__grid :deep(.backups-view__label-cell) {
  max-width: 130px;
}
.backups-view__name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.backups-view__file-icon {
  flex: none;
  color: var(--nd-text-muted);
}
.backups-view__file-icon--locked {
  color: rgb(var(--v-theme-warning));
}
.backups-view__newest {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 17px;
  padding: 0 7px;
  border-radius: var(--nd-radius-pill);
  font-size: 10.5px;
  font-weight: 600;
  color: var(--nd-text);
  background: var(--nd-accent-gradient-soft);
  box-shadow: inset 0 0 0 1px rgba(var(--nd-accent-rgb), 0.35);
}
.backups-view__schema,
.backups-view__date {
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
  white-space: nowrap;
}
.backups-view__label {
  display: block;
  color: var(--nd-text-2);
}
.backups-view__details {
  width: 350px;
  flex: 0 0 350px;
  overflow: hidden;
  border-left: 1px solid var(--nd-border);
  background: var(--nd-bg-panel);
}
</style>
