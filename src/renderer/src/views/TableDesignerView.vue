<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { TableStructure } from '@shared/types'
import { api } from '@renderer/api'
import EmptyState from '@renderer/components/common/EmptyState.vue'
import SqlEditor from '@renderer/components/common/SqlEditor.vue'
import { firstError, friendlyError } from '@renderer/components/data/privileges'
import ColumnsEditor from '@renderer/components/designer/ColumnsEditor.vue'
import ForeignKeysEditor from '@renderer/components/designer/ForeignKeysEditor.vue'
import { buildDesignerAlter, type DesignerAlter } from '@renderer/components/designer/alterTable'
import IndexesEditor from '@renderer/components/designer/IndexesEditor.vue'
import { ENGINES } from '@renderer/components/designer/columnType'
import { validateDraft } from '@renderer/components/designer/validateDraft'
import { useConfirm } from '@renderer/composables/useConfirm'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'
import { tabTitle, useTabsStore, type WorkspaceTab } from '@renderer/stores/tabs'
import { useTreeStore } from '@renderer/stores/tree'
import {
  buildCreateTable,
  draftFromStructure,
  emptyColumn,
  emptyTable,
  type TableDraft
} from '@renderer/utils/tableDesigner'

const props = defineProps<{ tab: WorkspaceTab }>()

const tabs = useTabsStore()
const tree = useTreeStore()
const connections = useConnectionsStore()
const notify = useNotify()
const { confirmDestructive } = useConfirm()

type Charset = { charset: string; defaultCollation: string; collations: string[] }

const tableName = ref<string | null>(props.tab.objectName || null)
const original = ref<TableStructure | null>(null)
const draft = ref<TableDraft>(emptyTable())
const initialSnapshot = ref('')
const charsets = ref<Charset[]>([])
const schemas = ref<string[]>([])
const section = ref('fields')
const loading = ref(false)
const saving = ref(false)
const loadError = ref<string | null>(null)

const connectionId = computed(() => props.tab.connectionId ?? '')
const schema = computed(() => props.tab.schema ?? '')
const isNew = computed(() => !original.value)
const columnNames = computed(() => draft.value.columns.map((c) => c.name).filter(Boolean))

const plan = computed<DesignerAlter>(() => {
  if (!original.value) {
    const statements =
      draft.value.name && draft.value.columns.length
        ? [buildCreateTable(schema.value, draft.value)]
        : []
    return { statements, risks: [], problems: [], drops: [] }
  }
  return buildDesignerAlter(original.value, draft.value)
})
const statements = computed(() => plan.value.statements)
const previewSql = computed(() =>
  statements.value.length ? statements.value.join('\n\n') : '-- Sin cambios'
)
const dirty = computed(() =>
  isNew.value ? JSON.stringify(draft.value) !== initialSnapshot.value : statements.value.length > 0
)
const validation = computed(() => validateDraft(draft.value) ?? plan.value.problems[0] ?? null)

const charset = computed(
  () => charsets.value.find((c) => c.collations.includes(draft.value.collation))?.charset ?? null
)
const collationItems = computed(
  () =>
    charsets.value.find((c) => c.charset === charset.value)?.collations ?? [draft.value.collation]
)

watch(dirty, (value) => tabs.setDirty(props.tab.id, value), { immediate: true })

function setCharset(name: string | null): void {
  const found = charsets.value.find((c) => c.charset === name)
  if (found) draft.value = { ...draft.value, collation: found.defaultCollation }
}

function newTableDraft(): TableDraft {
  const id = {
    ...emptyColumn(),
    name: 'id',
    columnType: 'int',
    nullable: false,
    autoIncrement: true,
    primaryKey: true,
    unsigned: true
  }
  return { ...emptyTable(), columns: [id] }
}

async function loadStructure(): Promise<void> {
  if (!connectionId.value || !schema.value) {
    loadError.value = 'La pestaña no tiene conexión o esquema asociados'
    return
  }
  loading.value = true
  loadError.value = null
  try {
    if (tableName.value) {
      const structure = await api.invokeSilent(
        'db:tableStructure',
        connectionId.value,
        schema.value,
        tableName.value
      )
      original.value = structure
      draft.value = draftFromStructure(structure)
    } else {
      original.value = null
      draft.value = newTableDraft()
    }
    initialSnapshot.value = JSON.stringify(draft.value)
  } catch (err) {
    loadError.value = errorMessage(err)
  } finally {
    loading.value = false
  }
}

async function loadLookups(): Promise<void> {
  if (!connectionId.value) return
  const [cs, dbs] = await Promise.allSettled([
    api.invokeSilent('db:charsets', connectionId.value),
    api.db.databases(connectionId.value)
  ])
  if (cs.status === 'fulfilled') charsets.value = cs.value
  if (dbs.status === 'fulfilled') schemas.value = dbs.value.map((d) => d.name)
}

async function save(): Promise<void> {
  if (saving.value || !dirty.value) return
  if (validation.value) {
    notify.warning(validation.value)
    return
  }
  const sql = statements.value.join('\n')
  if (!sql) return
  // Risky changes (drops, type narrowing, NOT NULL, renames) always ask; production always asks via useConfirm.
  const risks = plan.value.risks
  const drops = plan.value.drops
  const ok = await confirmDestructive({
    connectionId: connectionId.value,
    title: isNew.value ? 'Crear tabla' : 'Modificar tabla',
    message: risks.length
      ? `Revisa los cambios antes de aplicarlos. Esta operación no se puede deshacer:\n• ${risks.join('\n• ')}`
      : 'Se aplicarán los cambios de estructura.',
    details: sql,
    confirmText: risks.length ? 'Aplicar cambios' : undefined,
    alwaysAsk: risks.length > 0,
    destructive: drops.length
      ? {
          title:
            drops.length === 1
              ? `¿Eliminar 1 elemento de la tabla «${tableName.value}»?`
              : `¿Eliminar ${drops.length} elementos de la tabla «${tableName.value}»?`,
          message: `Revisa los cambios antes de aplicarlos. Esta operación no se puede deshacer:\n• ${risks.join('\n• ')}`,
          items: drops.map((d) => ({ tag: `DROP ${d.kind}`, text: d.name })),
          details: sql,
          confirmText: 'Eliminar'
        }
      : undefined
  })
  if (!ok) return

  saving.value = true
  try {
    const results = await api.invokeSilent('db:execute', connectionId.value, sql, {
      schema: schema.value,
      confirmProduction: true
    })
    const error = firstError(results)
    if (error) {
      notify.error(friendlyError(error))
      // Earlier statements may already be applied: reload to show the real state.
      if (!isNew.value) await loadStructure()
      return
    }
    const created = isNew.value
    const renamed = !created && draft.value.name !== tableName.value
    tableName.value = draft.value.name
    if (created || renamed) {
      tabs.setTitle(
        props.tab.id,
        tabTitle(draft.value.name, schema.value, connections.nameOf(connectionId.value))
      )
      void tree.loadGroup(connectionId.value, schema.value, 'tables', true).catch(() => undefined)
    }
    notify.success(
      created ? `Tabla "${draft.value.name}" creada` : `Tabla "${draft.value.name}" modificada`
    )
    await loadStructure()
  } catch (err) {
    notify.error(friendlyError(errorMessage(err)))
  } finally {
    saving.value = false
  }
}

async function revert(): Promise<void> {
  await loadStructure()
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    void save()
  }
}

onMounted(async () => {
  await Promise.all([loadStructure(), loadLookups()])
})

defineExpose({ draft, previewSql, save })
</script>

<template>
  <div class="nd-view designer" @keydown="onKeydown">
    <div class="nd-viewbar" role="toolbar" aria-label="Acciones del diseñador">
      <v-btn
        prepend-icon="mdi-content-save-outline"
        size="small"
        color="primary"
        variant="flat"
        :disabled="!dirty || loading"
        :loading="saving"
        title="Guardar (Cmd+S)"
        data-test="save"
        @click="save"
      >
        Guardar
      </v-btn>
      <v-btn
        prepend-icon="mdi-undo"
        size="small"
        class="ml-1"
        :disabled="!dirty || saving"
        data-test="revert"
        @click="revert"
        >Descartar</v-btn
      >
      <span class="nd-viewbar__sep" aria-hidden="true" />
      <v-btn
        prepend-icon="mdi-refresh"
        size="small"
        :disabled="saving"
        :loading="loading"
        @click="loadStructure"
        >Recargar</v-btn
      >
      <span class="nd-viewbar__spacer" />
      <span
        v-if="dirty && validation"
        class="nd-status-pill nd-status-pill--warning designer__validation mr-2"
        :title="validation"
      >
        <v-icon icon="mdi-alert-outline" size="13" />
        <span class="nd-ellipsis">{{ validation }}</span>
      </span>
      <span v-if="isNew" class="nd-status-pill nd-status-pill--accent">
        <span class="nd-status-pill__dot" aria-hidden="true" />
        Nueva tabla
      </span>
    </div>

    <EmptyState
      v-if="loadError"
      icon="mdi-alert-circle-outline"
      title="No se pudo cargar la estructura"
      :description="loadError"
    >
      <v-btn variant="tonal" size="small" prepend-icon="mdi-refresh" @click="loadStructure"
        >Reintentar</v-btn
      >
    </EmptyState>

    <template v-else>
      <v-tabs v-model="section" density="compact" class="nd-segmented designer__tabs">
        <v-tab value="fields" data-test="tab-fields">
          <v-icon icon="mdi-table-column" size="15" class="mr-2" />Campos
        </v-tab>
        <v-tab value="indexes" data-test="tab-indexes">
          <v-icon icon="mdi-lightning-bolt-outline" size="15" class="mr-2" />Índices
        </v-tab>
        <v-tab value="fks" data-test="tab-fks">
          <v-icon icon="mdi-key-link" size="15" class="mr-2" />Claves foráneas
        </v-tab>
        <v-tab value="options" data-test="tab-options">
          <v-icon icon="mdi-tune-variant" size="15" class="mr-2" />Opciones
        </v-tab>
        <v-tab value="sql" data-test="tab-sql">
          <v-icon icon="mdi-code-tags" size="15" class="mr-2" />Vista previa SQL
        </v-tab>
      </v-tabs>
      <div class="nd-viewpanel">
        <v-progress-linear
          v-if="loading"
          indeterminate
          color="primary"
          height="2"
          class="nd-viewpanel__loader"
        />
        <v-window v-model="section" class="designer__body">
          <v-window-item value="fields" class="fill">
            <ColumnsEditor v-model="draft.columns" />
          </v-window-item>
          <v-window-item value="indexes" class="fill">
            <IndexesEditor v-model="draft.indexes" :column-names="columnNames" />
          </v-window-item>
          <v-window-item value="fks" class="fill">
            <ForeignKeysEditor
              v-model="draft.foreignKeys"
              :column-names="columnNames"
              :schemas="schemas"
              :default-schema="schema"
            />
          </v-window-item>
          <v-window-item value="options" class="fill">
            <div class="designer__options">
              <div class="designer__options-title">Propiedades de la tabla</div>
              <v-row dense>
                <v-col cols="12" md="6">
                  <v-text-field
                    v-model="draft.name"
                    label="Nombre de la tabla"
                    data-test="table-name"
                  />
                </v-col>
                <v-col cols="12" md="6">
                  <v-combobox
                    v-model="draft.engine"
                    :items="ENGINES"
                    label="Motor"
                    density="compact"
                    variant="outlined"
                    hide-details
                  />
                </v-col>
                <v-col cols="12" md="6">
                  <v-select
                    :model-value="charset"
                    :items="charsets.map((c) => c.charset)"
                    label="Juego de caracteres"
                    no-data-text="No disponible"
                    @update:model-value="setCharset"
                  />
                </v-col>
                <v-col cols="12" md="6">
                  <v-combobox
                    v-model="draft.collation"
                    :items="collationItems"
                    label="Intercalación"
                    density="compact"
                    variant="outlined"
                    hide-details
                  />
                </v-col>
                <v-col cols="12" md="6">
                  <v-text-field
                    :model-value="draft.autoIncrement ?? ''"
                    label="Auto incremento"
                    type="number"
                    min="1"
                    @update:model-value="
                      draft.autoIncrement = $event === '' || $event === null ? null : Number($event)
                    "
                  />
                </v-col>
                <v-col cols="12">
                  <v-textarea
                    v-model="draft.comment"
                    label="Comentario"
                    class="nd-ui-font"
                    rows="2"
                    density="compact"
                    variant="outlined"
                    hide-details
                    auto-grow
                  />
                </v-col>
              </v-row>
            </div>
          </v-window-item>
          <v-window-item value="sql" class="fill">
            <SqlEditor :model-value="previewSql" readonly data-test="sql-preview" />
          </v-window-item>
        </v-window>
      </div>
    </template>
  </div>
</template>

<style scoped src="../components/data/viewChrome.css"></style>
<style scoped>
.designer__validation {
  max-width: 420px;
}
.designer__tabs {
  flex: 0 0 auto;
  margin: 0 12px 10px !important;
}
.designer__tabs :deep(.v-tab .v-icon) {
  color: var(--nd-text-muted);
}
.designer__tabs :deep(.v-tab--selected .v-icon) {
  color: var(--nd-accent);
}
.designer__body {
  flex: 1 1 auto;
  min-height: 0;
}
.designer__body :deep(.v-window__container),
.fill {
  height: 100%;
}
.designer__options {
  max-width: 880px;
  padding: 20px 24px;
  overflow: auto;
}
.designer__options-title {
  margin: 0 4px 14px;
  font-size: var(--nd-fs-title);
  font-weight: var(--nd-fw-heading);
  color: var(--nd-text);
}
.designer__options :deep(.v-col) {
  padding-block: 8px;
}
</style>
