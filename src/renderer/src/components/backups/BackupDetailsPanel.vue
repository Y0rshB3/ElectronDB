<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { BackupFile, BackupMeta, BackupObjectSummary } from '@shared/types'
import { api } from '@renderer/api'
import { errorMessage } from '@renderer/composables/useNotify'
import { useBackupsStore } from '@renderer/stores/backups'
import { formatBytes, formatDate, formatNumber } from '@renderer/utils/format'
import SqlEditor from '@renderer/components/common/SqlEditor.vue'
import SourcePill from './SourcePill.vue'
import { backupObjectTypeLabel } from './backupHelpers'

const props = defineProps<{ file: BackupFile }>()
const emit = defineEmits<{ close: [] }>()

const backups = useBackupsStore()
const meta = ref<BackupMeta | null>(null)
const loading = ref(false)
const error = ref('')
const selectedObject = ref<BackupObjectSummary | null>(null)
const ddl = ref('')
const ddlLoading = ref(false)

const headers = [
  { title: 'Tipo', key: 'type', width: 96, nowrap: true },
  { title: 'Nombre', key: 'name', cellProps: { class: 'backup-details__name-cell' } },
  { title: 'Filas', key: 'rows', align: 'end' as const, width: 90, nowrap: true }
]

/** Icon for a backup object type as stored in meta.json (Table, View, Function...). */
function typeIcon(type: string): string {
  const t = type.toLowerCase()
  if (t.includes('view')) return 'mdi-table-eye'
  if (t.includes('func') || t.includes('proc')) return 'mdi-function-variant'
  if (t.includes('event')) return 'mdi-calendar-clock-outline'
  if (t.includes('trigger')) return 'mdi-lightning-bolt-outline'
  return 'mdi-table'
}

const totalRows = computed(
  () => meta.value?.objects.reduce((sum, o) => sum + (o.rows ?? 0), 0) ?? 0
)

async function loadMeta(): Promise<void> {
  loading.value = true
  error.value = ''
  meta.value = null
  selectedObject.value = null
  ddl.value = ''
  try {
    meta.value = await backups.meta(props.file.path)
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    loading.value = false
  }
}

async function showDdl(obj: BackupObjectSummary): Promise<void> {
  selectedObject.value = obj
  ddlLoading.value = true
  ddl.value = ''
  try {
    ddl.value = await api.backups.objectDdl(props.file.path, obj.uuid)
  } catch (err) {
    ddl.value = `-- No se pudo leer el DDL: ${errorMessage(err)}`
  } finally {
    ddlLoading.value = false
  }
}

function onRowClick(_e: unknown, row: { item: BackupObjectSummary }): void {
  void showDdl(row.item)
}

watch(() => props.file.path, loadMeta, { immediate: true })
</script>

<template>
  <aside
    class="backup-details d-flex flex-column"
    aria-label="Detalles de la copia de seguridad"
    data-test="backup-details"
  >
    <header class="backup-details__head">
      <span class="nd-icon-badge" aria-hidden="true"
        ><v-icon icon="mdi-archive-outline" size="18"
      /></span>
      <div class="backup-details__title">
        <div class="backup-details__file nd-ellipsis" :title="file.path">{{ file.fileName }}</div>
        <div class="backup-details__when nd-mono">{{ formatDate(file.createdAt) }}</div>
      </div>
      <v-btn
        icon="mdi-close"
        size="small"
        aria-label="Cerrar detalles"
        title="Cerrar detalles"
        @click="emit('close')"
      />
    </header>

    <dl class="backup-details__facts">
      <dt>Esquema</dt>
      <dd class="nd-mono">{{ meta?.schema ?? file.schema ?? '—' }}</dd>
      <dt>Tamaño</dt>
      <dd class="nd-mono">{{ formatBytes(file.sizeBytes) }}</dd>
      <dt>Origen</dt>
      <dd><SourcePill :source="file.source" /></dd>
      <template v-if="file.label">
        <dt>Etiqueta</dt>
        <dd class="nd-ellipsis" :title="file.label">{{ file.label }}</dd>
      </template>
      <template v-if="meta?.comment">
        <dt>Comentario</dt>
        <dd class="backup-details__comment">{{ meta.comment }}</dd>
      </template>
    </dl>

    <div v-if="meta" class="backup-details__stats">
      <div class="backup-details__stat">
        <span class="backup-details__stat-value nd-mono">{{
          formatNumber(meta.objects.length)
        }}</span>
        <span class="backup-details__stat-label">objetos</span>
      </div>
      <div class="backup-details__stat">
        <span class="backup-details__stat-value nd-mono">{{ formatNumber(totalRows) }}</span>
        <span class="backup-details__stat-label">filas</span>
      </div>
    </div>

    <v-alert v-if="error" type="error" class="mx-3 mb-2">{{ error }}</v-alert>
    <div class="backup-details__section nd-section-title">Objetos</div>
    <div class="backup-details__objects">
      <v-data-table
        :headers="headers"
        :items="meta?.objects ?? []"
        :loading="loading"
        item-value="uuid"
        density="compact"
        :items-per-page="-1"
        hide-default-footer
        hover
        fixed-header
        no-data-text="Sin objetos"
        loading-text="Leyendo meta.json…"
        :row-props="
          ({ item }) => ({ class: item.uuid === selectedObject?.uuid ? 'bg-surface-variant' : '' })
        "
        @click:row="onRowClick"
      >
        <template #[`item.type`]="{ item }">
          <span class="backup-details__type">
            <v-icon :icon="typeIcon(item.type)" size="14" aria-hidden="true" />{{
              backupObjectTypeLabel(item.type)
            }}
          </span>
        </template>
        <template #[`item.name`]="{ item }">
          <span class="nd-ellipsis d-block" :title="item.name">{{ item.name }}</span>
        </template>
        <template #[`item.rows`]="{ item }">
          <span class="nd-num">{{ formatNumber(item.rows) }}</span>
        </template>
      </v-data-table>
    </div>
    <template v-if="selectedObject">
      <div class="backup-details__section backup-details__section--ddl">
        <span class="nd-section-title">DDL</span>
        <span class="nd-mono nd-ellipsis backup-details__ddl-name" :title="selectedObject.name">{{
          selectedObject.name
        }}</span>
      </div>
      <div class="backup-details__ddl">
        <div
          v-if="ddlLoading"
          class="nd-progress backup-details__ddl-progress"
          role="progressbar"
          aria-label="Leyendo DDL"
        >
          <span class="backup-details__ddl-bar" />
        </div>
        <SqlEditor :model-value="ddl" readonly min-height="160px" />
      </div>
    </template>
  </aside>
</template>

<style scoped>
.backup-details {
  height: 100%;
  min-width: 0;
}
.backup-details__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 12px 12px 16px;
}
.backup-details__title {
  flex: 1;
  min-width: 0;
}
.backup-details__file {
  font-size: var(--nd-fs-base);
  font-weight: var(--nd-fw-heading);
  color: var(--nd-text);
}
.backup-details__when {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.backup-details__facts {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  gap: 6px 12px;
  margin: 0 16px;
  padding: 12px 14px;
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-border);
  font-size: var(--nd-fs-dense);
}
.backup-details__facts dt {
  color: var(--nd-text-muted);
}
.backup-details__facts dd {
  margin: 0;
  min-width: 0;
  color: var(--nd-text);
}
.backup-details__comment {
  white-space: pre-wrap;
  word-break: break-word;
}
.backup-details__stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin: 10px 16px 0;
}
.backup-details__stat {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 8px 12px;
  border-radius: var(--nd-radius-control);
  background: var(--nd-accent-gradient-soft);
  border: 1px solid rgba(var(--nd-accent-rgb), 0.16);
}
.backup-details__stat-value {
  font-size: var(--nd-fs-title);
  font-weight: 600;
  color: var(--nd-text);
  font-variant-numeric: tabular-nums;
}
.backup-details__stat-label {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.backup-details__section {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 16px 6px;
}
.backup-details__section--ddl {
  border-top: 1px solid var(--nd-border);
  padding-top: 10px;
}
.backup-details__ddl-name {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text);
}
.backup-details__objects {
  flex: 1 1 50%;
  overflow: auto;
  min-height: 120px;
  margin: 0 8px;
}
.backup-details__objects :deep(.backup-details__name-cell) {
  max-width: 0;
  width: 100%;
}
.backup-details__type {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--nd-text-2);
  white-space: nowrap;
}
.backup-details__type .v-icon {
  color: var(--nd-text-muted);
}
.backup-details__ddl {
  position: relative;
  flex: 1 1 40%;
  min-height: 160px;
  margin: 0 12px 12px;
  overflow: hidden;
  border-radius: var(--nd-radius-control);
  border: 1px solid var(--nd-border);
  background: var(--nd-bg-sunken);
}
.backup-details__ddl-progress {
  position: absolute;
  inset: 0 0 auto;
  z-index: 2;
}
.backup-details__ddl-bar {
  width: 40%;
  animation: ddl-indeterminate 1.1s var(--nd-ease) infinite;
}
@keyframes ddl-indeterminate {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(250%);
  }
}
</style>
