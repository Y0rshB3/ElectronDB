<script setup lang="ts">
/**
 * MongoDB collection designer (docs/multi-engine-design.md, 9.5): indexes
 * (create with keys 1/-1/text/2dsphere/hashed, unique, sparse, hidden, TTL,
 * partial filter, collation; drop with confirmation, never `_id_`), the
 * validator (`$jsonSchema` or query operators, level and action, with
 * «Generar esquema» from sampled field types) and the read-only options.
 * Without a collection it creates one.
 */
import { computed, onMounted, ref } from 'vue'
import type { MongoCollectionDetails, MongoIndexInfo } from '@shared/types'
import { parseEjson, shellText } from '@shared/mongo/shellFormat'
import { api } from '@renderer/api'
import SqlEditor from '@renderer/components/common/SqlEditor.vue'
import EmptyState from '@renderer/components/common/EmptyState.vue'
import { keysSummaryOf } from '@renderer/components/mongo/docModel'
import { jsonSchemaFrom } from '@renderer/components/mongo/schemaGen'
import { typedTarget, useConfirm } from '@renderer/composables/useConfirm'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useWorkspace } from '@renderer/composables/useWorkspace'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useTabsStore, type WorkspaceTab, tabTitle } from '@renderer/stores/tabs'
import { useTreeStore } from '@renderer/stores/tree'
import { formatBytes, formatNumber } from '@renderer/utils/format'

const props = defineProps<{ tab: WorkspaceTab }>()
const connections = useConnectionsStore()
const tabs = useTabsStore()
const tree = useTreeStore()
const notify = useNotify()
const workspace = useWorkspace()
const { confirmDestructive } = useConfirm()

const connectionId = computed(() => props.tab.connectionId ?? '')
const database = computed(() => props.tab.schema ?? '')
const collection = ref(props.tab.objectName ?? '')
const creating = computed(() => !collection.value)
const section = ref<'indexes' | 'validator' | 'options'>(
  ((props.tab.payload?.section as string) ?? 'indexes') as 'indexes' | 'validator' | 'options'
)

const details = ref<MongoCollectionDetails | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)
const busy = ref(false)
const formError = ref<string | null>(null)

/** Write options after the typed confirmation on guarded connections; null = cancelled. */
async function confirmWrite(
  title: string,
  message: string,
  destructive = false
): Promise<{ confirmProduction?: boolean } | null> {
  const guarded = connections.needsTypedConfirm(connectionId.value)
  if (!guarded && !destructive) return {}
  const ok = await confirmDestructive({
    connectionId: connectionId.value,
    title,
    message,
    alwaysAsk: destructive,
    ...(guarded
      ? { confirmText: `Ejecutar en ${typedTarget(connections.get(connectionId.value))}` }
      : {})
  })
  if (!ok) return null
  return guarded ? { confirmProduction: true } : {}
}

async function load(): Promise<void> {
  if (creating.value) return
  loading.value = true
  loadError.value = null
  try {
    details.value = await api.mongo.collectionDetails(
      connectionId.value,
      database.value,
      collection.value
    )
    validatorText.value = details.value.validator
      ? shellText(parseEjson(details.value.validator), { indent: 2 })
      : ''
    validationLevel.value =
      (details.value.validationLevel as typeof validationLevel.value) ?? 'strict'
    validationAction.value = details.value.validationAction === 'warn' ? 'warn' : 'error'
  } catch (err) {
    loadError.value = errorMessage(err)
  } finally {
    loading.value = false
  }
}

function refreshTree(): void {
  const node = tree.parse(
    `g:${encodeURIComponent(connectionId.value)}:${encodeURIComponent(database.value)}:collections`
  )
  if (node) void tree.refresh(node)
  const ix = tree.parse(
    `g:${encodeURIComponent(connectionId.value)}:${encodeURIComponent(database.value)}:indexes`
  )
  if (ix && tree.hasItems(connectionId.value, database.value, 'indexes')) void tree.refresh(ix)
}

/* ---------- new collection ---------- */

const newName = ref('')
const capped = ref(false)
const cappedSize = ref<number | null>(1048576)
const cappedMax = ref<number | null>(null)

async function createCollection(): Promise<void> {
  formError.value = null
  const name = newName.value.trim()
  if (!name) {
    formError.value = 'Escribe el nombre de la colección.'
    return
  }
  const options = await confirmWrite(
    `Crear la colección «${name}»`,
    `Se creará la colección ${name} en ${database.value}.`
  )
  if (!options) return
  busy.value = true
  try {
    await api.mongo.createCollection(
      connectionId.value,
      database.value,
      name,
      {
        capped: capped.value,
        size: capped.value ? Number(cappedSize.value) || 0 : undefined,
        max: capped.value && cappedMax.value ? Number(cappedMax.value) : undefined,
        validator: validatorText.value
      },
      options
    )
    notify.success(`Colección «${name}» creada`)
    collection.value = name
    tabs.setTitle(
      props.tab.id,
      tabTitle(name, database.value, connections.nameOf(connectionId.value))
    )
    tabs.setTarget(props.tab.id, connectionId.value, database.value)
    const tab = tabs.tabs.find((t) => t.id === props.tab.id)
    if (tab) tab.objectName = name
    refreshTree()
    await load()
  } catch {
    /* shown by api.invoke */
  } finally {
    busy.value = false
  }
}

/* ---------- indexes ---------- */

type KeyKind = '1' | '-1' | 'text' | '2dsphere' | 'hashed'
const KEY_KINDS: { value: KeyKind; title: string }[] = [
  { value: '1', title: 'Ascendente (1)' },
  { value: '-1', title: 'Descendente (-1)' },
  { value: 'text', title: 'Texto' },
  { value: '2dsphere', title: '2dsphere' },
  { value: 'hashed', title: 'Hash' }
]
const keyRows = ref<{ field: string; kind: KeyKind }[]>([{ field: '', kind: '1' }])
const ixName = ref('')
const ixUnique = ref(false)
const ixSparse = ref(false)
const ixHidden = ref(false)
const ixTtl = ref<number | null>(null)
const ixPartial = ref('')
const ixCollation = ref('')
const newIndexOpen = ref(false)

const keysText = computed(() => {
  const parts = keyRows.value
    .filter((r) => r.field.trim())
    .map(
      (r) =>
        `${JSON.stringify(r.field.trim())}: ${r.kind === '1' || r.kind === '-1' ? r.kind : `'${r.kind}'`}`
    )
  return `{ ${parts.join(', ')} }`
})

function resetIndexForm(): void {
  keyRows.value = [{ field: '', kind: '1' }]
  ixName.value = ''
  ixUnique.value = false
  ixSparse.value = false
  ixHidden.value = false
  ixTtl.value = null
  ixPartial.value = ''
  ixCollation.value = ''
  formError.value = null
}

async function createIndex(): Promise<void> {
  formError.value = null
  if (!keyRows.value.some((r) => r.field.trim())) {
    formError.value = 'Añade al menos un campo al índice.'
    return
  }
  const options = await confirmWrite(
    `Crear un índice en «${collection.value}»`,
    `Claves: ${keysText.value}`
  )
  if (!options) return
  busy.value = true
  try {
    const name = await api.mongo.createIndex(
      connectionId.value,
      database.value,
      collection.value,
      {
        keys: keysText.value,
        name: ixName.value.trim() || undefined,
        unique: ixUnique.value,
        sparse: ixSparse.value,
        hidden: ixHidden.value,
        expireAfterSeconds:
          ixTtl.value === null || ixTtl.value === ('' as never) ? null : Number(ixTtl.value),
        partialFilter: ixPartial.value,
        collation: ixCollation.value
      },
      options
    )
    notify.success(`Índice «${name}» creado`)
    newIndexOpen.value = false
    resetIndexForm()
    refreshTree()
    await load()
  } catch (err) {
    formError.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}

async function dropIndex(ix: MongoIndexInfo): Promise<void> {
  const options = await confirmWrite(
    `¿Eliminar el índice «${ix.name}»?`,
    `Se eliminará el índice ${ix.name} (${keysSummaryOf(ix.keys)}) de ${collection.value}.`,
    true
  )
  if (!options) return
  try {
    await api.mongo.dropIndex(
      connectionId.value,
      database.value,
      collection.value,
      ix.name,
      options
    )
    notify.success(`Índice «${ix.name}» eliminado`)
    refreshTree()
    await load()
  } catch {
    /* shown by api.invoke */
  }
}

/* ---------- validator ---------- */

const validatorText = ref('')
const validationLevel = ref<'off' | 'strict' | 'moderate'>('strict')
const validationAction = ref<'error' | 'warn'>('error')
const generating = ref(false)

async function generateSchema(): Promise<void> {
  generating.value = true
  try {
    const fields = await api.mongo.sampleFields(
      connectionId.value,
      database.value,
      collection.value,
      1000
    )
    validatorText.value = jsonSchemaFrom(fields)
    notify.info('Esquema propuesto a partir de una muestra: revísalo antes de guardar')
  } catch (err) {
    notify.error(errorMessage(err))
  } finally {
    generating.value = false
  }
}

async function saveValidator(): Promise<void> {
  formError.value = null
  const options = await confirmWrite(
    `Cambiar el validador de «${collection.value}»`,
    validatorText.value.trim()
      ? 'Los documentos nuevos o modificados se comprobarán con este validador.'
      : 'Se quitará el validador de la colección.'
  )
  if (!options) return
  busy.value = true
  try {
    await api.mongo.setValidator(
      connectionId.value,
      database.value,
      collection.value,
      {
        validator: validatorText.value,
        level: validationLevel.value,
        action: validationAction.value
      },
      options
    )
    notify.success('Validador guardado')
    await load()
  } catch (err) {
    formError.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}

/* ---------- rename ---------- */

const renameTo = ref('')
async function rename(): Promise<void> {
  const to = renameTo.value.trim()
  if (!to || to === collection.value) return
  const from = collection.value
  const options = await confirmWrite(
    `Renombrar «${from}»`,
    `La colección ${from} pasará a llamarse ${to}.`
  )
  if (!options) return
  busy.value = true
  try {
    await api.mongo.renameCollection(connectionId.value, database.value, from, to, options)
    notify.success(`«${from}» ahora se llama «${to}»`)
    collection.value = to
    const tab = tabs.tabs.find((t) => t.id === props.tab.id)
    if (tab) tab.objectName = to
    tabs.setTitle(
      props.tab.id,
      tabTitle(to, database.value, connections.nameOf(connectionId.value))
    )
    renameTo.value = ''
    refreshTree()
    await load()
  } catch {
    /* shown by api.invoke */
  } finally {
    busy.value = false
  }
}

const optionsText = computed(() =>
  details.value ? shellText(parseEjson(details.value.options), { indent: 2 }) : ''
)
const readOnlyView = computed(() => details.value?.info.type === 'view')

onMounted(load)
</script>

<template>
  <div class="nd-view collection-designer" data-test="collection-designer">
    <div class="nd-viewbar" role="toolbar" aria-label="Diseño de la colección">
      <template v-if="!creating">
        <v-btn size="small" prepend-icon="mdi-refresh" :loading="loading" @click="load"
          >Refrescar</v-btn
        >
        <v-btn
          size="small"
          prepend-icon="mdi-file-document-multiple-outline"
          @click="workspace.openCollection(connectionId, database, collection)"
          >Abrir documentos</v-btn
        >
      </template>
      <span class="nd-viewbar__spacer" />
      <span v-if="details" class="nd-status-pill">
        {{ details.info.count === null ? '—' : formatNumber(details.info.count) }} documentos ·
        {{ formatBytes(details.info.sizeBytes) }}
      </span>
    </div>

    <div class="nd-viewpanel collection-designer__panel">
      <div v-if="creating" class="collection-designer__create">
        <div class="nd-section-title mb-2">Nueva colección en {{ database }}</div>
        <v-row dense>
          <v-col cols="12" sm="6">
            <v-text-field
              v-model="newName"
              label="Nombre"
              class="nd-mono-input"
              autofocus
              data-test="new-collection-name"
            />
          </v-col>
          <v-col cols="12" sm="6" class="d-flex align-center">
            <v-switch
              v-model="capped"
              label="Colección limitada (capped)"
              color="primary"
              density="compact"
              hide-details
            />
          </v-col>
          <template v-if="capped">
            <v-col cols="6">
              <v-text-field
                v-model.number="cappedSize"
                label="Tamaño máximo (bytes)"
                type="number"
                min="1"
              />
            </v-col>
            <v-col cols="6">
              <v-text-field
                v-model.number="cappedMax"
                label="Máximo de documentos (opcional)"
                type="number"
                min="0"
              />
            </v-col>
          </template>
          <v-col cols="12">
            <div class="nd-section-title mb-1">Validador (opcional)</div>
            <div class="collection-designer__editor collection-designer__editor--small">
              <SqlEditor v-model="validatorText" engine="mongodb" min-height="140px" />
            </div>
          </v-col>
        </v-row>
        <v-alert v-if="formError" type="error" variant="tonal" density="compact" class="mt-2">{{
          formError
        }}</v-alert>
        <div class="d-flex justify-end mt-3">
          <v-btn
            color="primary"
            variant="flat"
            prepend-icon="mdi-plus"
            :loading="busy"
            data-test="create-collection"
            @click="createCollection"
            >Crear colección</v-btn
          >
        </div>
      </div>

      <template v-else>
        <v-tabs
          v-model="section"
          density="compact"
          color="primary"
          class="collection-designer__tabs"
        >
          <v-tab value="indexes" prepend-icon="mdi-sort-ascending" data-test="designer-indexes"
            >Índices</v-tab
          >
          <v-tab
            value="validator"
            prepend-icon="mdi-shield-check-outline"
            :disabled="readOnlyView"
            data-test="designer-validator"
            >Validador</v-tab
          >
          <v-tab value="options" prepend-icon="mdi-information-outline" data-test="designer-options"
            >Opciones</v-tab
          >
        </v-tabs>
        <v-progress-linear v-if="loading" indeterminate color="primary" height="2" />
        <EmptyState
          v-if="loadError"
          icon="mdi-alert-circle-outline"
          title="No se pudo leer la colección"
          :description="loadError"
        />

        <div v-else-if="section === 'indexes'" class="collection-designer__section">
          <div class="d-flex align-center mb-2">
            <span class="nd-section-title">Índices de {{ collection }}</span>
            <v-spacer />
            <v-btn
              size="small"
              prepend-icon="mdi-plus"
              :disabled="readOnlyView"
              data-test="index-new"
              @click="((newIndexOpen = !newIndexOpen), resetIndexForm())"
              >Nuevo índice</v-btn
            >
          </div>
          <v-card
            v-if="newIndexOpen"
            variant="outlined"
            class="collection-designer__new mb-3"
            data-test="index-form"
          >
            <v-card-text>
              <div v-for="(row, i) in keyRows" :key="i" class="d-flex align-center ga-2 mb-1">
                <v-text-field
                  v-model="row.field"
                  label="Campo"
                  density="compact"
                  hide-details
                  class="nd-mono-input"
                  :data-test="`index-field-${i}`"
                />
                <v-select
                  v-model="row.kind"
                  :items="KEY_KINDS"
                  label="Tipo"
                  density="compact"
                  hide-details
                  class="collection-designer__kind"
                />
                <v-btn
                  icon="mdi-close"
                  size="small"
                  variant="text"
                  :disabled="keyRows.length === 1"
                  aria-label="Quitar campo"
                  @click="keyRows.splice(i, 1)"
                />
              </div>
              <v-btn
                size="small"
                variant="text"
                prepend-icon="mdi-plus"
                @click="keyRows.push({ field: '', kind: '1' })"
                >Añadir campo</v-btn
              >
              <v-row dense class="mt-1">
                <v-col cols="12" sm="6"
                  ><v-text-field
                    v-model="ixName"
                    label="Nombre (opcional)"
                    density="compact"
                    class="nd-mono-input"
                /></v-col>
                <v-col cols="12" sm="6"
                  ><v-text-field
                    v-model.number="ixTtl"
                    label="TTL en segundos (opcional)"
                    type="number"
                    min="0"
                    density="compact"
                /></v-col>
                <v-col cols="4"
                  ><v-checkbox v-model="ixUnique" label="Único" density="compact" hide-details
                /></v-col>
                <v-col cols="4"
                  ><v-checkbox v-model="ixSparse" label="Disperso" density="compact" hide-details
                /></v-col>
                <v-col cols="4"
                  ><v-checkbox v-model="ixHidden" label="Oculto" density="compact" hide-details
                /></v-col>
                <v-col cols="12" sm="6">
                  <v-text-field
                    v-model="ixPartial"
                    label="Filtro parcial (opcional)"
                    placeholder="{ activo: true }"
                    persistent-placeholder
                    density="compact"
                    class="nd-mono-input"
                  />
                </v-col>
                <v-col cols="12" sm="6">
                  <v-text-field
                    v-model="ixCollation"
                    label="Intercalación (opcional)"
                    placeholder="{ locale: 'es', strength: 2 }"
                    persistent-placeholder
                    density="compact"
                    class="nd-mono-input"
                  />
                </v-col>
              </v-row>
              <div class="text-caption text-medium-emphasis nd-mono">Claves: {{ keysText }}</div>
              <v-alert
                v-if="formError"
                type="error"
                variant="tonal"
                density="compact"
                class="mt-2"
                >{{ formError }}</v-alert
              >
            </v-card-text>
            <v-card-actions>
              <v-spacer />
              <v-btn @click="newIndexOpen = false">Cancelar</v-btn>
              <v-btn
                color="primary"
                variant="flat"
                :loading="busy"
                data-test="index-create"
                @click="createIndex"
                >Crear índice</v-btn
              >
            </v-card-actions>
          </v-card>
          <table class="collection-designer__table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Claves</th>
                <th>Opciones</th>
                <th aria-label="Acciones" />
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="ix in details?.indexes ?? []"
                :key="ix.name"
                :data-test="`index-row-${ix.name}`"
              >
                <td class="nd-mono">{{ ix.name }}</td>
                <td class="nd-mono">{{ keysSummaryOf(ix.keys) }}</td>
                <td>
                  <span class="collection-designer__flags">
                    <span v-if="ix.unique">único</span>
                    <span v-if="ix.sparse">disperso</span>
                    <span v-if="ix.hidden">oculto</span>
                    <span v-if="ix.expireAfterSeconds !== null"
                      >TTL {{ ix.expireAfterSeconds }} s</span
                    >
                    <span v-if="ix.partialFilter" :title="ix.partialFilter">parcial</span>
                    <span v-if="ix.collation" :title="ix.collation">intercalación</span>
                  </span>
                </td>
                <td class="text-right">
                  <v-btn
                    v-if="ix.name !== '_id_'"
                    icon="mdi-delete-outline"
                    size="x-small"
                    variant="text"
                    :aria-label="`Eliminar el índice ${ix.name}`"
                    title="Eliminar índice"
                    @click="dropIndex(ix)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-else-if="section === 'validator'" class="collection-designer__section">
          <div class="d-flex align-center ga-2 mb-2 flex-wrap">
            <v-select
              v-model="validationLevel"
              :items="[
                { value: 'strict', title: 'Estricto (todas las escrituras)' },
                { value: 'moderate', title: 'Moderado (solo documentos válidos)' },
                { value: 'off', title: 'Desactivado' }
              ]"
              label="Nivel de validación"
              density="compact"
              hide-details
              class="collection-designer__select"
            />
            <v-select
              v-model="validationAction"
              :items="[
                { value: 'error', title: 'Rechazar (error)' },
                { value: 'warn', title: 'Avisar en el registro (warn)' }
              ]"
              label="Acción"
              density="compact"
              hide-details
              class="collection-designer__select"
            />
            <v-spacer />
            <v-btn
              size="small"
              prepend-icon="mdi-auto-fix"
              :loading="generating"
              data-test="schema-generate"
              @click="generateSchema"
              >Generar esquema</v-btn
            >
            <v-btn
              size="small"
              color="primary"
              variant="flat"
              prepend-icon="mdi-content-save-outline"
              :loading="busy"
              data-test="validator-save"
              @click="saveValidator"
              >Guardar validador</v-btn
            >
          </div>
          <div class="collection-designer__editor">
            <SqlEditor v-model="validatorText" engine="mongodb" min-height="260px" />
          </div>
          <div class="text-caption text-medium-emphasis mt-1">
            Vacío = sin validador. Admite <span class="nd-mono">$jsonSchema</span> y operadores de
            consulta.
          </div>
          <v-alert v-if="formError" type="error" variant="tonal" density="compact" class="mt-2">{{
            formError
          }}</v-alert>
        </div>

        <div v-else class="collection-designer__section">
          <div v-if="details" class="collection-designer__facts">
            <div>
              <span>Tipo</span
              >{{
                details.info.type === 'view'
                  ? 'Vista'
                  : details.info.type === 'timeseries'
                    ? 'Serie temporal'
                    : 'Colección'
              }}
            </div>
            <div>
              <span>Documentos</span
              >{{ details.info.count === null ? '—' : formatNumber(details.info.count) }}
            </div>
            <div><span>Tamaño</span>{{ formatBytes(details.info.sizeBytes) }}</div>
            <div><span>Almacenamiento</span>{{ formatBytes(details.info.storageSizeBytes) }}</div>
            <div><span>Edición</span>{{ details.info.readOnlyReason ?? 'Editable por _id' }}</div>
          </div>
          <div v-if="details?.info.type === 'collection'" class="d-flex align-center ga-2 mt-3">
            <v-text-field
              v-model="renameTo"
              label="Nuevo nombre"
              :placeholder="collection"
              persistent-placeholder
              density="compact"
              hide-details
              class="nd-mono-input collection-designer__rename"
              data-test="rename-input"
              @keydown.enter.prevent="rename"
            />
            <v-btn
              size="small"
              prepend-icon="mdi-rename-outline"
              :disabled="!renameTo.trim() || renameTo.trim() === collection"
              :loading="busy"
              data-test="rename-apply"
              @click="rename"
              >Renombrar</v-btn
            >
          </div>
          <div class="nd-section-title mt-3 mb-1">Opciones (solo lectura)</div>
          <pre class="collection-designer__options nd-mono" data-test="designer-options-text">{{
            optionsText
          }}</pre>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped src="@renderer/components/data/viewChrome.css"></style>
<style scoped>
.collection-designer__panel {
  overflow: auto;
}
.collection-designer__create,
.collection-designer__section {
  padding: 12px 16px;
}
.collection-designer__tabs {
  border-bottom: 1px solid var(--nd-hairline);
}
.collection-designer__tabs :deep(.v-tab) {
  text-transform: none;
}
.collection-designer__editor {
  height: 320px;
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-control);
  overflow: hidden;
}
.collection-designer__editor--small {
  height: 170px;
}
.collection-designer__kind {
  flex: 0 0 180px;
}
.collection-designer__select {
  flex: 0 1 260px;
  min-width: 220px;
}
.collection-designer__table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--nd-fs-dense);
}
.collection-designer__table th,
.collection-designer__table td {
  padding: 6px 8px;
  text-align: left;
  border-bottom: 1px solid var(--nd-hairline);
}
.collection-designer__table th {
  color: var(--nd-text-2);
  font-weight: 600;
}
.collection-designer__flags {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
}
.collection-designer__flags span {
  padding: 0 6px;
  border-radius: var(--nd-radius-pill);
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  background: var(--nd-hover);
}
.collection-designer__facts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
  font-size: var(--nd-fs-dense);
}
.collection-designer__facts span {
  display: block;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.collection-designer__options {
  margin: 0;
  padding: 8px 10px;
  font-size: var(--nd-fs-dense);
  background: var(--nd-bg-sunken);
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-control);
  white-space: pre-wrap;
}
.collection-designer__rename {
  flex: 0 1 320px;
}
.collection-designer__table td.text-right {
  text-align: right;
}
</style>
