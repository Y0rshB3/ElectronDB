<script setup lang="ts">
/**
 * Documents of a collection (or of a query-tab result) in three modes —
 * Tabla, Árbol, JSON — with inline edits staged until «Aplicar», the whole
 * document editor, insert/duplicate/delete by `_id`, and «Cargar más»
 * (docs/multi-engine-design.md, 9.1 and 9.2). Shared by CollectionView and
 * MongoQueryView.
 */
import { computed, ref, shallowRef, triggerRef, watch } from 'vue'
import type { MongoDocumentChange, MongoDocumentPage } from '@shared/types'
import {
  bsonTypeOf,
  isContainer,
  isEditableType,
  shellLossReasons,
  largeValue,
  parseEjson,
  shellText,
  valueAt,
  type EjsonObject,
  type EjsonValue
} from '@shared/mongo/shellFormat'
import { api } from '@renderer/api'
import { typedTarget, useConfirm } from '@renderer/composables/useConfirm'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import type { MenuAction } from '@renderer/composables/useObjectActions'
import { useConnectionsStore } from '@renderer/stores/connections'
import ContextMenu from '@renderer/components/common/ContextMenu.vue'
import EmptyState from '@renderer/components/common/EmptyState.vue'
import DocumentGrid from './DocumentGrid.vue'
import DocumentTreeNode from './DocumentTreeNode.vue'
import DocumentEditorDialog from './DocumentEditorDialog.vue'
import TypedValueDialog from './TypedValueDialog.vue'
import {
  changesFor,
  columnsOf,
  currentDoc,
  dotted,
  editCount,
  emptyEdit,
  insertTemplate,
  isChanged,
  parseRows,
  pathProblem,
  stageValue,
  withoutId,
  type DocRow,
  type DocumentMode,
  type PathSegment,
  type StagedEdit
} from './docModel'

const props = defineProps<{
  connectionId: string
  database: string
  collection: string
  page: MongoDocumentPage | null
  /** Why documents cannot be edited here, or null. */
  readOnlyReason: string | null
  /** Number of the first document (paging). */
  offset?: number
  loading?: boolean
}>()
const mode = defineModel<DocumentMode>('mode', { default: 'table' })
const localTime = defineModel<boolean>('localTime', { default: false })
const emit = defineEmits<{
  reload: []
  loadMore: []
  /** Staged edits count changed (the tab's dirty flag). */
  pending: [count: number]
}>()

const connections = useConnectionsStore()
const notify = useNotify()
const { confirmDestructive } = useConfirm()

const rows = shallowRef<DocRow[]>([])
const edits = shallowRef(new Map<number, StagedEdit>())
const selected = ref<number[]>([])
const applying = ref(false)
const applyError = ref<string | null>(null)
const menu = ref<InstanceType<typeof ContextMenu> | null>(null)

watch(
  () => props.page,
  (page, previous) => {
    const docs = page?.docs ?? []
    const appended =
      !!previous &&
      previous.docs.length <= docs.length &&
      previous.docs.every((d, i) => d === docs[i])
    rows.value = parseRows(docs, page?.whole ?? [])
    if (!appended) {
      edits.value = new Map()
      selected.value = []
      applyError.value = null
    }
  },
  { immediate: true }
)

const docs = computed(() => rows.value.map((r, i) => currentDoc(r, edits.value.get(i))))
const columns = computed(() => columnsOf(props.page?.fields ?? [], rows.value))
const pendingCount = computed(() => {
  let n = 0
  for (const [i, e] of edits.value) n += editCount(e, rows.value[i])
  return n
})
watch(pendingCount, (n) => emit('pending', n))
const readonly = computed(() => !!props.readOnlyReason)
const changedCells = computed(() => {
  const out: Record<number, string[]> = {}
  for (const [i, e] of edits.value) {
    const keys = new Set<string>()
    for (const p of e.set.keys()) keys.add(p.split('.')[0])
    for (const p of e.unset) keys.add(p.split('.')[0])
    out[i] = [...keys]
  }
  return out
})
const deletedRows = computed(() => [...edits.value].filter(([, e]) => e.deleted).map(([i]) => i))

function editOf(index: number): StagedEdit {
  let e = edits.value.get(index)
  if (!e) {
    e = emptyEdit()
    edits.value.set(index, e)
  }
  return e
}
function touch(): void {
  triggerRef(edits)
}

function select(index: number, additive: boolean): void {
  if (additive)
    selected.value = selected.value.includes(index)
      ? selected.value.filter((i) => i !== index)
      : [...selected.value, index]
  else selected.value = [index]
}

/* ---------- typed inline editor ---------- */

const valueDialog = ref(false)
const valueTarget = ref<{ index: number; path: PathSegment[]; askKey: boolean } | null>(null)
const valueCurrent = computed<EjsonValue | undefined>(() => {
  const t = valueTarget.value
  if (!t || t.askKey) return undefined
  return valueAt(docs.value[t.index], t.path)
})
const valueLabel = computed(() => (valueTarget.value ? dotted(valueTarget.value.path) : ''))

function editPath(index: number, path: PathSegment[]): void {
  if (readonly.value) return notify.warning(props.readOnlyReason ?? 'Solo lectura')
  const value = valueAt(docs.value[index], path)
  const problem = pathProblem(path)
  if (problem) return notify.warning(problem)
  // Documents, arrays, large values and types without a plain editor (binary, timestamp…)
  // are edited in the whole-document editor, which keeps their exact type.
  if (
    value !== undefined &&
    (isContainer(value) || largeValue(value) || !isEditableType(bsonTypeOf(value)))
  ) {
    void openEditor(index)
    return
  }
  valueTarget.value = { index, path, askKey: false }
  valueDialog.value = true
}

function onValueSaved(value: EjsonValue, key: string | null): void {
  const t = valueTarget.value
  if (!t) return
  const row = rows.value[t.index]
  const edit = editOf(t.index)
  let path = t.path
  if (t.askKey && key !== null) path = [...t.path, key]
  else if (t.askKey) {
    const arr = valueAt(docs.value[t.index], t.path)
    path = [...t.path, Array.isArray(arr) ? arr.length : 0]
  }
  const problem = stageValue(row, edit, path, value)
  if (problem) notify.warning(problem)
  touch()
}

function addAt(index: number, path: PathSegment[]): void {
  if (readonly.value) return
  const target = path.length ? valueAt(docs.value[index], path) : docs.value[index]
  valueTarget.value = { index, path, askKey: !Array.isArray(target) }
  valueDialog.value = true
}

function removeAt(index: number, path: PathSegment[]): void {
  if (readonly.value) return
  const problem = stageValue(rows.value[index], editOf(index), path, undefined)
  if (problem) notify.warning(problem)
  touch()
}

/* ---------- whole document editor ---------- */

const editorOpen = ref(false)
const editorText = ref('')
const editorTitle = ref('')
const editorSubtitle = ref('')
const editorError = ref<string | null>(null)
const editorSaving = ref(false)
const editorReadonly = ref(false)
type EditorAction = { kind: 'replace'; id: string; original: string } | { kind: 'insert' }
let editorAction: EditorAction = { kind: 'insert' }

/** The whole document (refetched by _id when the page has it projected or truncated). */
async function wholeDoc(index: number): Promise<{ doc: EjsonObject; text: string } | null> {
  const row = rows.value[index]
  if (row.whole) return { doc: row.original, text: row.text }
  const id = row.original._id
  if (id === undefined) return null
  const text = await api.mongo.document(
    props.connectionId,
    props.database,
    props.collection,
    JSON.stringify(id)
  )
  if (!text) {
    notify.warning('El documento ya no existe: recarga la vista.')
    return null
  }
  return { doc: parseEjson(text) as EjsonObject, text }
}

async function openEditor(index: number): Promise<void> {
  if (edits.value.get(index) && editCount(edits.value.get(index), rows.value[index])) {
    notify.warning('Aplica o descarta los cambios de este documento antes de editarlo completo.')
    return
  }
  let whole: { doc: EjsonObject; text: string } | null
  try {
    whole = await wholeDoc(index)
  } catch {
    return
  }
  if (!whole) return
  const id = whole.doc._id
  const lossy = shellLossReasons(whole.doc)
  editorReadonly.value = readonly.value || id === undefined || lossy.length > 0
  editorTitle.value = editorReadonly.value ? 'Ver documento' : 'Editar documento'
  editorSubtitle.value = `${props.collection} · _id ${id === undefined ? '—' : shellText(id)}`
  editorText.value = shellText(whole.doc, { indent: 2 })
  editorAction = { kind: 'replace', id: JSON.stringify(id ?? null), original: whole.text }
  editorError.value = lossy.length
    ? `Solo lectura: el documento contiene ${lossy.join(', ')}, que el editor no puede guardar sin cambiarlo. Edita los demás campos en la rejilla o en el árbol.`
    : null
  editorOpen.value = true
}

function openInsert(): void {
  editorReadonly.value = false
  editorTitle.value = 'Insertar documento'
  editorSubtitle.value = props.collection
  editorText.value = insertTemplate(props.page?.fields ?? [])
  editorAction = { kind: 'insert' }
  editorError.value = null
  editorOpen.value = true
}

async function openDuplicate(index: number): Promise<void> {
  const whole = await wholeDoc(index).catch(() => null)
  if (!whole) return
  const lossy = shellLossReasons(whole.doc)
  if (lossy.length) {
    notify.warning(
      `No se puede duplicar desde el editor: el documento contiene ${lossy.join(', ')}.`
    )
    return
  }
  editorReadonly.value = false
  editorTitle.value = 'Duplicar documento'
  editorSubtitle.value = `${props.collection} · el _id se genera al insertar`
  editorText.value = shellText(withoutId(whole.doc), { indent: 2 })
  editorAction = { kind: 'insert' }
  editorError.value = null
  editorOpen.value = true
}

async function guardWrite(
  title: string,
  message: string,
  destructive = false
): Promise<boolean | null> {
  const guarded = connections.needsTypedConfirm(props.connectionId)
  if (!guarded && !destructive) return false
  const ok = await confirmDestructive({
    connectionId: props.connectionId,
    title,
    message,
    alwaysAsk: destructive,
    ...(guarded
      ? { confirmText: `Guardar en ${typedTarget(connections.get(props.connectionId))}` }
      : {})
  })
  return ok ? guarded : null
}

async function saveEditor(text: string): Promise<void> {
  const change: MongoDocumentChange =
    editorAction.kind === 'insert'
      ? { kind: 'insert', doc: text }
      : {
          kind: 'replace',
          id: editorAction.id,
          doc: text,
          fetchedWhole: true,
          original: editorAction.original
        }
  const guarded = await guardWrite(
    editorAction.kind === 'insert'
      ? `Insertar en «${props.collection}»`
      : `Reemplazar el documento`,
    editorAction.kind === 'insert'
      ? 'Se insertará el documento.'
      : 'Se reemplazará el documento completo por el texto editado.'
  )
  if (guarded === null) return
  editorSaving.value = true
  editorError.value = null
  try {
    const result = await api.mongo.applyChanges(
      props.connectionId,
      props.database,
      props.collection,
      [change],
      guarded ? { confirmProduction: true } : undefined
    )
    if (result.failure) {
      editorError.value = result.failure.message
      return
    }
    notify.success(editorAction.kind === 'insert' ? 'Documento insertado' : 'Documento guardado')
    editorOpen.value = false
    emit('reload')
  } catch (err) {
    editorError.value = errorMessage(err)
  } finally {
    editorSaving.value = false
  }
}

/* ---------- delete, apply, discard ---------- */

function stageDelete(indexes: number[]): void {
  if (readonly.value) return
  for (const i of indexes) {
    if (rows.value[i]?.original._id === undefined) continue
    const e = editOf(i)
    e.deleted = !e.deleted
  }
  touch()
}

function discard(): void {
  edits.value = new Map()
  applyError.value = null
}

async function apply(): Promise<void> {
  const changes = changesFor(rows.value, edits.value)
  if (!changes.length) return discard()
  const deletes = changes.filter((c) => c.kind === 'delete').length
  const guarded = await guardWrite(
    `Aplicar ${changes.length} cambio(s) en «${props.collection}»`,
    deletes
      ? `Se modificarán ${changes.length - deletes} documento(s) y se eliminarán ${deletes}.`
      : `Se modificarán ${changes.length} documento(s).`,
    deletes > 0
  )
  if (guarded === null) return
  applying.value = true
  applyError.value = null
  try {
    const result = await api.mongo.applyChanges(
      props.connectionId,
      props.database,
      props.collection,
      changes,
      guarded ? { confirmProduction: true } : undefined
    )
    if (result.failure) {
      applyError.value = result.failure.message
      if (result.applied) emit('reload')
      return
    }
    notify.success(
      `${result.applied} cambio(s) aplicados${result.atomic ? ' en una transacción' : ''}`
    )
    edits.value = new Map()
    emit('reload')
  } catch (err) {
    applyError.value = errorMessage(err)
  } finally {
    applying.value = false
  }
}

/* ---------- copy and context menu ---------- */

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    notify.success(`${what} copiado`)
  } catch {
    notify.warning('No se pudo copiar al portapapeles')
  }
}

function idFilter(index: number): string | null {
  const id = rows.value[index]?.original._id
  return id === undefined ? null : `{ _id: ${shellText(id)} }`
}

function onMenu(event: MouseEvent, index: number, column: string | null): void {
  if (!selected.value.includes(index)) selected.value = [index]
  const doc = docs.value[index]
  const value = column ? doc[column] : undefined
  const id = doc._id
  const items: MenuAction[] = []
  if (column && value !== undefined) {
    items.push({
      key: 'copyValue',
      label: 'Copiar valor',
      icon: 'mdi-content-copy',
      action: () =>
        copy(
          id !== undefined && column === '_id' && (value as EjsonObject).$oid
            ? String((value as EjsonObject).$oid)
            : typeof value === 'string'
              ? value
              : shellText(value),
          'Valor'
        )
    })
    if (column !== '_id' && !readonly.value)
      items.push({
        key: 'editValue',
        label: 'Editar valor…',
        icon: 'mdi-pencil-outline',
        action: () => editPath(index, [column])
      })
  }
  const filter = idFilter(index)
  if (filter)
    items.push({
      key: 'copyFilter',
      label: 'Copiar como filtro',
      icon: 'mdi-filter-outline',
      action: () => copy(filter, 'Filtro')
    })
  items.push(
    {
      key: 'copyDoc',
      label: 'Copiar documento',
      icon: 'mdi-code-json',
      action: () => copy(shellText(doc, { indent: 2 }), 'Documento')
    },
    { key: 'd1', label: '', divider: true },
    {
      key: 'openDoc',
      label: readonly.value ? 'Ver documento' : 'Editar documento…',
      icon: 'mdi-file-document-edit-outline',
      action: () => openEditor(index)
    }
  )
  if (!readonly.value)
    items.push(
      {
        key: 'duplicate',
        label: 'Duplicar documento…',
        icon: 'mdi-content-duplicate',
        action: () => openDuplicate(index)
      },
      {
        key: 'delete',
        label: edits.value.get(index)?.deleted ? 'No eliminar' : 'Eliminar documento',
        icon: 'mdi-delete-outline',
        danger: true,
        action: () => stageDelete(selected.value.length ? selected.value : [index])
      }
    )
  menu.value?.show(event, items)
}

defineExpose({ pendingCount, apply, discard, openInsert })
</script>

<template>
  <div class="document-browser">
    <div class="document-browser__bar nd-viewbar--rowedit" role="toolbar" aria-label="Documentos">
      <v-btn-toggle
        v-model="mode"
        mandatory
        density="compact"
        divided
        class="document-browser__modes"
      >
        <v-btn value="table" size="small" prepend-icon="mdi-table" data-test="mode-table"
          >Tabla</v-btn
        >
        <v-btn value="tree" size="small" prepend-icon="mdi-file-tree-outline" data-test="mode-tree"
          >Árbol</v-btn
        >
        <v-btn value="json" size="small" prepend-icon="mdi-code-json" data-test="mode-json"
          >JSON</v-btn
        >
      </v-btn-toggle>
      <v-btn
        size="small"
        :class="{ 'is-active': localTime }"
        prepend-icon="mdi-clock-outline"
        :aria-pressed="localTime"
        title="Mostrar las fechas en hora local (por defecto UTC)"
        data-test="local-time"
        @click="localTime = !localTime"
        >Hora local</v-btn
      >
      <span class="nd-viewbar__sep" aria-hidden="true" />
      <v-btn
        size="small"
        prepend-icon="mdi-plus"
        :disabled="readonly"
        data-test="doc-insert"
        @click="openInsert"
        >Insertar</v-btn
      >
      <v-btn
        size="small"
        prepend-icon="mdi-file-document-edit-outline"
        :disabled="selected.length !== 1"
        data-test="doc-edit"
        @click="openEditor(selected[0])"
        >{{ readonly ? 'Ver' : 'Editar' }}</v-btn
      >
      <v-btn
        size="small"
        prepend-icon="mdi-content-duplicate"
        :disabled="readonly || selected.length !== 1"
        @click="openDuplicate(selected[0])"
        >Duplicar</v-btn
      >
      <v-btn
        size="small"
        prepend-icon="mdi-delete-outline"
        :disabled="readonly || !selected.length"
        data-test="doc-delete"
        @click="stageDelete(selected)"
        >Eliminar</v-btn
      >
      <span class="nd-viewbar__spacer" />
      <template v-if="pendingCount">
        <span class="nd-status-pill nd-status-pill--warning" data-test="doc-pending"
          >{{ pendingCount }} cambio(s) sin aplicar</span
        >
        <v-btn size="small" prepend-icon="mdi-undo-variant" @click="discard">Descartar</v-btn>
        <v-btn
          size="small"
          color="primary"
          variant="flat"
          prepend-icon="mdi-check"
          :loading="applying"
          data-test="doc-apply"
          @click="apply"
          >Aplicar</v-btn
        >
      </template>
    </div>

    <div
      v-if="readOnlyReason"
      class="document-browser__notice"
      role="note"
      data-test="doc-readonly"
    >
      <v-icon icon="mdi-lock-outline" size="14" />
      {{ readOnlyReason }}
    </div>
    <v-alert
      v-if="applyError"
      type="error"
      variant="tonal"
      density="compact"
      closable
      class="mx-2 mb-1"
      data-test="doc-apply-error"
      @click:close="applyError = null"
      >{{ applyError }}</v-alert
    >

    <div class="document-browser__content">
      <EmptyState
        v-if="!loading && page && !page.docs.length"
        icon="mdi-file-document-remove-outline"
        title="Sin documentos"
        description="No hay documentos que coincidan con el filtro."
      />
      <DocumentGrid
        v-else-if="mode === 'table'"
        :docs="docs"
        :columns="columns"
        :fields="page?.fields ?? []"
        :selected="selected"
        :changed="changedCells"
        :deleted="deletedRows"
        :local-time="localTime"
        :offset="offset ?? 0"
        @select="select"
        @edit="(i, c) => editPath(i, [c])"
        @menu="onMenu"
      />
      <div v-else-if="mode === 'tree'" class="document-browser__tree" data-test="document-tree">
        <section
          v-for="(doc, i) in docs"
          :key="i"
          class="document-browser__treedoc"
          :class="{ 'is-selected': selected.includes(i), 'is-deleted': deletedRows.includes(i) }"
          @click="select(i, $event.metaKey || $event.ctrlKey)"
          @contextmenu.prevent="onMenu($event, i, null)"
        >
          <header class="document-browser__treehead">
            <span class="nd-mono text-medium-emphasis">{{ (offset ?? 0) + i + 1 }}</span>
            <span class="nd-mono">{{
              doc._id === undefined ? '(sin _id)' : shellText(doc._id)
            }}</span>
            <span class="text-caption text-medium-emphasis"
              >{{ Object.keys(doc).length }} campos</span
            >
            <v-spacer />
            <v-btn
              v-if="!readonly"
              icon="mdi-plus"
              size="x-small"
              variant="text"
              aria-label="Añadir campo"
              title="Añadir campo"
              @click.stop="addAt(i, [])"
            />
          </header>
          <DocumentTreeNode
            v-for="key in Object.keys(doc)"
            :key="key"
            :label="key"
            :value="doc[key]"
            :path="[key]"
            :depth="0"
            :local-time="localTime"
            :readonly="readonly"
            :is-changed="(p) => isChanged(edits.get(i), p)"
            @edit="editPath(i, $event)"
            @remove="removeAt(i, $event)"
            @add="addAt(i, $event)"
          />
        </section>
      </div>
      <div v-else class="document-browser__json" data-test="document-json">
        <pre
          v-for="(doc, i) in docs"
          :key="i"
          class="document-browser__jsondoc nd-mono"
          :class="{ 'is-selected': selected.includes(i), 'is-deleted': deletedRows.includes(i) }"
          @click="select(i, $event.metaKey || $event.ctrlKey)"
          @dblclick="openEditor(i)"
          @contextmenu.prevent="onMenu($event, i, null)"
          >{{ shellText(doc, { indent: 2, localTime }) }}</pre>
      </div>
    </div>

    <div v-if="page?.truncated" class="document-browser__more">
      <v-btn
        size="small"
        variant="tonal"
        prepend-icon="mdi-chevron-double-down"
        :loading="loading"
        data-test="doc-load-more"
        @click="emit('loadMore')"
        >Cargar más</v-btn
      >
      <span class="text-caption text-medium-emphasis">{{ page.docs.length }} cargados</span>
    </div>

    <TypedValueDialog
      v-model="valueDialog"
      :label="valueLabel"
      :value="valueCurrent"
      :ask-key="valueTarget?.askKey ?? false"
      @save="onValueSaved"
    />
    <DocumentEditorDialog
      v-model="editorOpen"
      :title="editorTitle"
      :subtitle="editorSubtitle"
      :text="editorText"
      :saving="editorSaving"
      :error="editorError"
      :readonly="editorReadonly"
      :save-label="editorAction.kind === 'insert' ? 'Insertar' : 'Guardar'"
      @save="saveEditor"
    />
    <ContextMenu ref="menu" />
  </div>
</template>

<style scoped src="@renderer/components/data/viewChrome.css"></style>
<style scoped>
.document-browser {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.document-browser__bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--nd-hairline);
}
.document-browser__modes :deep(.v-btn) {
  text-transform: none;
}
.document-browser__notice {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  background: var(--nd-hover);
  border-bottom: 1px solid var(--nd-hairline);
}
.document-browser__content {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
.document-browser__tree,
.document-browser__json {
  height: 100%;
  overflow: auto;
  padding: 6px 8px;
}
.document-browser__treedoc {
  margin-bottom: 8px;
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-control);
  overflow: hidden;
}
.document-browser__treehead {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 8px;
  font-size: var(--nd-fs-dense);
  background: var(--nd-bg-sunken);
  border-bottom: 1px solid var(--nd-hairline);
}
.document-browser__jsondoc {
  margin: 0 0 8px;
  padding: 8px 10px;
  font-size: var(--nd-fs-dense);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--nd-bg-sunken);
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-control);
}
.is-selected {
  border-color: rgba(var(--nd-accent-rgb), 0.6) !important;
  box-shadow: var(--nd-glow);
}
.is-deleted {
  opacity: 0.55;
  text-decoration: line-through;
}
.document-browser__more {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-top: 1px solid var(--nd-hairline);
}
.is-active {
  color: var(--nd-cyan) !important;
}
</style>
