<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { engineOf } from '@shared/engines'
import { backupFamilyOf } from '@shared/jobEngines'
import { packageDate } from '@shared/backupPackages'
import type { BackupFile, ConnectionConfig, JobPackageSummary, JobTask } from '@shared/types'
import { useBackupsStore } from '@renderer/stores/backups'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useJobsStore } from '@renderer/stores/jobs'
import { useQueriesStore } from '@renderer/stores/queries'
import { useSettingsStore } from '@renderer/stores/settings'
import { ENVIRONMENT_LABELS } from '@renderer/utils/objectTypes'
import { formatDate } from '@renderer/utils/format'
import { useSchemaLoader } from '@renderer/components/backups/useSchemaLoader'
import { automationConnections, canBackup } from '@renderer/components/backups/backupHelpers'
import { TASK_ICONS, newPackageTask } from './jobForm'
import {
  STEP_KINDS,
  backupStep,
  dedupeSteps,
  connectionsForKind,
  inJob,
  restorableSteps,
  restoreFromLatest,
  restoreFromStep,
  restoresOf,
  savedQueriesFor,
  savedQueryStep,
  sqlStep,
  visibleDatabases,
  type StepKind
} from './jobSteps'
import { ADD_DRAG_TYPE, endAddDrag, startAddDrag } from './stepDrag'

/**
 * «Añadir pasos»: pick a kind of step, browse connection › database and add
 * the available items to the job (double click, «Añadir» with several
 * checked, or dragging them onto the sequence). Connections are opened only
 * when the user expands them.
 */
const props = defineProps<{
  tasks: JobTask[]
  /** The job being edited (its own packages are «Esta tarea», not another automation). */
  jobId?: string | null
}>()
const collapsed = defineModel<boolean>('collapsed', { default: false })
const emit = defineEmits<{
  add: [tasks: JobTask[]]
  /** «Copiar y restaurar», proposing the selected connection as origin. */
  recipe: [sourceId: string | null]
}>()

const connections = useConnectionsStore()
const settings = useSettingsStore()
const queries = useQueriesStore()
const backups = useBackupsStore()
const jobs = useJobsStore()
const schemaLoader = useSchemaLoader()

const kind = ref<StepKind>('backup')
const filter = ref('')
const selectedConnection = ref<string | null>(null)
const selectedDatabase = ref<string | null>(null)
const expanded = ref<Record<string, boolean>>({})
const checked = ref<string[]>([])

const kindMeta = computed(() => STEP_KINDS.find((k) => k.value === kind.value)!)

const kindConnections = computed(() => connectionsForKind(kind.value, connections.sorted))
const filteredConnections = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return kindConnections.value
  return kindConnections.value.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      visibleDatabases(c, schemaLoader.of(c.id)).some((d) => d.toLowerCase().includes(q))
  )
})

function databasesOf(c: ConnectionConfig): string[] {
  const all = visibleDatabases(c, schemaLoader.of(c.id))
  const q = filter.value.trim().toLowerCase()
  if (!q || c.name.toLowerCase().includes(q)) return all
  return all.filter((d) => d.toLowerCase().includes(q))
}

const connection = computed(() =>
  selectedConnection.value ? (connections.get(selectedConnection.value) ?? null) : null
)

// A kind that cannot use the selected connection clears the selection.
watch(kind, () => {
  checked.value = []
  if (
    selectedConnection.value &&
    !kindConnections.value.some((c) => c.id === selectedConnection.value)
  ) {
    selectedConnection.value = null
    selectedDatabase.value = null
  }
})
watch([selectedConnection, selectedDatabase], () => (checked.value = []))
// The packages of the other automations are read when the restore list is shown.
watch(
  kind,
  (k) => {
    if (k === 'restore') void jobs.loadPackages()
  },
  { immediate: true }
)

const ENV_PILL: Record<string, string> = {
  production: 'nd-pill--production',
  staging: 'nd-pill--staging',
  local: 'nd-pill--local'
}

/** Expanding a connection lists its databases (and opens it: a user action). */
async function toggle(c: ConnectionConfig, open?: boolean): Promise<void> {
  const next = open ?? !expanded.value[c.id]
  expanded.value = { ...expanded.value, [c.id]: next }
  if (next) await schemaLoader.load(c.id)
}

function selectConnection(c: ConnectionConfig): void {
  selectedConnection.value = c.id
  selectedDatabase.value = null
  // Saved queries are stored locally: listing them needs no connection.
  if (kind.value !== 'savedQuery' && !expanded.value[c.id]) void toggle(c, true)
}

function selectDatabase(c: ConnectionConfig, name: string): void {
  selectedConnection.value = c.id
  selectedDatabase.value = name
}

function onConnectionKey(event: KeyboardEvent, c: ConnectionConfig): void {
  if (event.key === 'ArrowRight' && !expanded.value[c.id]) void toggle(c, true)
  else if (event.key === 'ArrowLeft' && expanded.value[c.id]) void toggle(c, false)
  else return
  event.preventDefault()
}

const blocked = (c: ConnectionConfig): boolean => settings.needsTypedConfirm(c.environment)
const usable = computed(() => automationConnections(connections.sorted))

/* ---------- available items ---------- */

interface Item {
  key: string
  icon: string
  title: string
  subtitle: string
  mono?: boolean
  inJob?: string
  build: () => JobTask[]
}
/** Connection shown as a pill in a package header. */
interface PackPill {
  id: string
  name: string
  icon: string
  environment: string
}
/**
 * Header row of a package group: adds the whole package as one «Restaurar
 * paquete» step (also by checking every item of the group).
 */
interface PackHeader {
  key: string
  title: string
  subtitle: string
  sources: PackPill[]
  target: PackPill | null
  inJob?: string
  build: () => JobTask[]
  /** Some items checked: what they add (default: each item's own step). */
  buildSome?: (items: Item[]) => JobTask[]
}
interface ItemGroup {
  key: string
  title: string
  pack?: PackHeader
  /** Section heading above the group (absent = the title; null = none). */
  heading?: string | null
  /** Package groups fold to their header. */
  collapsible?: boolean
  /** Muted text after the title. */
  note?: string
  items: Item[]
  empty?: string
  /** The empty group offers «Copiar y restaurar» instead of a passive hint. */
  recipe?: boolean
  /** No «Seleccionar todo» (a single shortcut item). */
  noSelectAll?: boolean
}

/** Job copies of the selected database found on disk (restore kind). */
const latestFiles = ref<BackupFile[]>([])
const latestLoading = ref(false)
/** Only the newest backups:list answer is shown. */
let latestToken = 0
watch(
  () => [kind.value, selectedConnection.value, selectedDatabase.value] as const,
  async ([k, connectionId, schema]) => {
    const token = ++latestToken
    latestFiles.value = []
    latestLoading.value = false
    if (k !== 'restore' || !connectionId || !schema) return
    latestLoading.value = true
    try {
      const files = await backups.load(connectionId, schema)
      if (token === latestToken)
        latestFiles.value = files.filter((f) => f.run && f.run.includeData !== false)
    } catch {
      // Reported by invoke(); the subtitle falls back to «aún no hay copias».
      if (token === latestToken) latestFiles.value = []
    } finally {
      if (token === latestToken) latestLoading.value = false
    }
  }
)

function databaseItems(c: ConnectionConfig): string[] {
  const all = visibleDatabases(c, schemaLoader.of(c.id))
  return selectedDatabase.value ? all.filter((d) => d === selectedDatabase.value) : all
}

/** Folded package groups (another automation's packages start folded). */
const folded = ref<Record<string, boolean>>({})
const isFolded = (g: ItemGroup): boolean => folded.value[g.key] ?? g.key.startsWith('job:')
function toggleFold(g: ItemGroup): void {
  folded.value = { ...folded.value, [g.key]: !isFolded(g) }
}

function pillOf(id: string | null | undefined): PackPill | null {
  const c = id ? connections.get(id) : undefined
  return c ? { id: c.id, name: c.name, icon: engineOf(c).icon, environment: c.environment } : null
}

function pillsOf(ids: (string | null | undefined)[]): PackPill[] {
  return [...new Set(ids.filter((id): id is string => !!id))]
    .map((id) => pillOf(id))
    .filter((p): p is PackPill => !!p)
}

/** Engine family of the first known connection of a package (its default target's engine). */
function familyOf(ids: (string | null | undefined)[]): ReturnType<typeof backupFamilyOf> | null {
  for (const id of ids) {
    const c = id ? connections.get(id) : undefined
    if (c) return backupFamilyOf(engineOf(c).id)
  }
  return null
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)
const copies = (n: number): string => `${n} ${n === 1 ? 'copia' : 'copias'}`

/** Another automation's package group: its latest package (or its steps, before its first run). */
function jobPackageGroup(pkg: JobPackageSummary, tasks: JobTask[]): ItemGroup {
  const latest = pkg.latest
  const entries = latest
    ? latest.copies.map((c) => ({
        schema: c.schema,
        connectionId: c.connectionId,
        structureOnly: c.structureOnly,
        encrypted: c.encrypted
      }))
    : pkg.steps.map((s) => ({
        schema: s.schema,
        connectionId: s.connectionId,
        structureOnly: !s.includeData,
        encrypted: false
      }))
  const ids = entries.map((e) => e.connectionId)
  const family = familyOf(ids)
  const source = { kind: 'job' as const, jobId: pkg.jobId, jobName: pkg.jobName }
  const sourceIds = ids.filter((id): id is string => !!id)
  const build = (databases?: string[]): JobTask[] => [
    newPackageTask(source, usable.value, blocked, family, databases, sourceIds)
  ]
  const preview = build()[0]
  const already = tasks.some(
    (t) =>
      t.type === 'restorepackage' &&
      t.packageSource?.kind === 'job' &&
      t.packageSource.jobId === pkg.jobId
  )
  const date = latest ? packageDate(latest.startedAt) : ''
  return {
    key: `job:${pkg.jobId}`,
    title: pkg.jobName,
    collapsible: true,
    pack: {
      key: `pack:job:${pkg.jobId}`,
      title: latest
        ? `${pkg.jobName} · último paquete (${date}, ${copies(latest.copies.length)})`
        : `${pkg.jobName} · aún sin paquete`,
      subtitle: `${capitalize(restoreTargetText(preview))} · un paso con su último paquete en cada ejecución${latest ? (latest.status === 'success' ? '' : ' · su última ejecución terminó con errores') : ' · aún no se ha ejecutado'}`,
      sources: pillsOf(ids),
      target: pillOf(preview.connectionId),
      inJob: already ? 'ya en la tarea' : undefined,
      build: () => build(),
      // Some databases: one package step restoring just those.
      buildSome: (items) => build(items.map((i) => i.key.slice(`pkg:${pkg.jobId}:`.length)))
    },
    items: entries.map((e) => {
      const conn = e.connectionId ? connections.get(e.connectionId)?.name : undefined
      return {
        key: `pkg:${pkg.jobId}:${e.schema}`,
        icon: 'mdi-database-outline',
        title: `${e.schema}${conn ? ` · ${conn}` : ''}`,
        subtitle: [
          latest ? `copia del ${date}` : 'aún sin copia',
          e.structureOnly ? 'solo estructura (no se restaura con datos)' : 'estructura y datos',
          e.encrypted ? 'cifrada' : ''
        ]
          .filter(Boolean)
          .join(' · '),
        build: () => build([e.schema])
      }
    })
  }
}

/** Where a restore item lands by default: «se restaura en Local con copia previa». */
function restoreTargetText(task: JobTask): string {
  const target = task.connectionId ? connections.get(task.connectionId) : undefined
  return target
    ? `se restaura en ${target.name} ${task.safetyBackup !== false ? 'con' : 'sin'} copia previa`
    : 'elige el destino en los ajustes del paso'
}

const groups = computed<ItemGroup[]>(() => {
  const c = connection.value
  const db = selectedDatabase.value
  const tasks = props.tasks
  if (kind.value === 'restore') {
    const steps = restorableSteps(tasks)
    const stepIds = steps.map(({ task }) => task.connectionId)
    const ownFamily = familyOf(stepIds)
    const ownSources = stepIds.filter(Boolean)
    const ownPackage = () =>
      newPackageTask({ kind: 'own' }, usable.value, blocked, ownFamily, undefined, ownSources)
    const ownPreview = ownPackage()
    const ownAlready = tasks.some(
      (t) => t.type === 'restorepackage' && t.packageSource?.kind === 'own'
    )
    const out: ItemGroup[] = [
      {
        key: 'steps',
        title: 'Esta tarea',
        note: 'sus copias se restauran después de hacerlas, en la misma ejecución',
        recipe: true,
        collapsible: true,
        pack: steps.length
          ? {
              key: 'pack:own',
              title: `Paquete de esta tarea · ${copies(steps.length)}`,
              subtitle: `${capitalize(restoreTargetText(ownPreview))} · un paso con todas las copias anteriores (también las que añadas)`,
              sources: pillsOf(stepIds),
              target: pillOf(ownPreview.connectionId),
              inJob: ownAlready ? 'ya en la tarea' : undefined,
              build: () => [ownPackage()]
            }
          : undefined,
        items: steps.map(({ task, index }) => {
          const used = restoresOf(task.id, tasks).length
          const preview = restoreFromStep(task, usable.value, blocked)
          const from = connections.get(task.connectionId)?.name ?? 'conexión eliminada'
          return {
            key: `step:${task.id}`,
            icon: TASK_ICONS.backupschema,
            title: `Copia de ${task.schema || '—'} (${from}) — ${task.includeData === false ? 'solo estructura' : 'estructura y datos'}`,
            subtitle: `Paso ${index + 1}${task.format === 'vqb' ? ` · .vqb${task.encrypt ? ' cifrada' : ''}` : ' · .nb3'} · ${restoreTargetText(preview)}`,
            inJob: used ? (used === 1 ? 'ya se restaura' : `se restaura ${used} veces`) : undefined,
            build: () => [restoreFromStep(task, usable.value, blocked)]
          }
        })
      }
    ]
    // Other automations that copy databases with their data: their latest package.
    let first = true
    for (const pkg of jobs.packages) {
      if (pkg.jobId === props.jobId) continue
      const withData = pkg.latest
        ? pkg.latest.copies.some((c) => !c.structureOnly)
        : pkg.steps.some((s) => s.includeData)
      if (!withData) continue
      const group = jobPackageGroup(pkg, tasks)
      group.heading = first ? 'Otras tareas' : null
      group.note = first ? 'el último paquete de cada una, al ejecutarse este paso' : undefined
      first = false
      out.push(group)
    }
    if (c) {
      const names = databaseItems(c)
      out.push({
        key: 'latest',
        title: `Copias en disco de ${c.name}`,
        note: 'la más reciente de cada base de datos',
        empty: schemaLoader.isLoading(c.id)
          ? 'Cargando bases de datos…'
          : schemaLoader.errorOf(c.id)
            ? schemaLoader.errorOf(c.id)
            : 'Sin bases de datos.',
        items: names.map((name) => ({
          key: `latest:${c.id}:${name}`,
          icon: 'mdi-archive-clock-outline',
          title: `Última copia de ${name} · ${c.name}`,
          subtitle:
            db === name
              ? latestLoading.value
                ? 'Buscando copias…'
                : latestFiles.value.length
                  ? `${latestFiles.value.length} copia(s) de tareas en disco · la más reciente del ${formatDate(latestFiles.value[0].createdAt)}`
                  : 'Aún no hay copias de tareas en disco: la ejecución usará la que exista entonces.'
              : 'La copia con datos más reciente hecha por una tarea',
          build: () => [restoreFromLatest(c, name, usable.value, blocked)]
        }))
      })
    }
    return out
  }
  if (!c) return []
  if (kind.value === 'backup') {
    const names = databaseItems(c)
    const out: ItemGroup[] = []
    // The whole connection: one backup step per database (system databases excluded).
    if (!db && names.length > 1) {
      const missing = names.filter((n) => !inJob(tasks, 'backupschema', c.id, n))
      const already = names.length - missing.length
      out.push({
        key: 'all',
        title: 'Toda la conexión',
        noSelectAll: true,
        items: [
          {
            key: `backup-all:${c.id}`,
            icon: 'mdi-database-arrow-down-outline',
            title: `Todas las bases de datos de ${c.name}`,
            subtitle: !already
              ? `${names.length} bases de datos, sin las del sistema · una copia por cada una`
              : missing.length
                ? `${names.length} bases de datos · ${already} ya en la tarea: ${missing.length === 1 ? 'se añade la que falta' : `se añaden las otras ${missing.length}`}`
                : `Las ${names.length} bases de datos ya se copian en esta tarea`,
            inJob: missing.length ? undefined : 'ya en la tarea',
            build: () => missing.map((name) => backupStep(c, name))
          }
        ]
      })
    }
    out.push({
      key: 'dbs',
      title: `Bases de datos · ${c.name}`,
      empty: schemaLoader.isLoading(c.id)
        ? 'Cargando bases de datos…'
        : (schemaLoader.errorOf(c.id) ?? 'Sin bases de datos.'),
      items: names.map((name) => ({
        key: `backup:${c.id}:${name}`,
        icon: 'mdi-database-outline',
        title: name,
        subtitle: `Copia ${engineOf(c).id === 'mysql' || engineOf(c).id === 'mariadb' ? 'en .vqb (o .nb3/.sql en sus ajustes)' : 'en .vqb'}`,
        inJob: inJob(tasks, 'backupschema', c.id, name) ? 'ya en la tarea' : undefined,
        build: () => [backupStep(c, name)]
      }))
    })
    return out
  }
  if (kind.value === 'savedQuery') {
    const list = savedQueriesFor(queries.list(c.id), db)
    return [
      {
        key: 'queries',
        title: `Consultas guardadas · ${db ?? c.name}`,
        empty: db
          ? `No hay consultas guardadas en ${db}. Elige la conexión para verlas todas, o guarda una desde una pestaña de consulta («Guardar consulta»).`
          : 'Esta conexión no tiene consultas guardadas. Guárdalas desde una pestaña de consulta («Guardar consulta»).',
        items: list.map((q) => {
          const first = q.sql.split('\n').find((l) => l.trim()) ?? ''
          return {
            key: `query:${c.id}:${q.id}`,
            icon: 'mdi-bookmark-outline',
            title: q.name,
            subtitle: `${q.schema ?? 'sin base de datos'} · ${first.trim().slice(0, 70)}`,
            mono: true,
            inJob: tasks.some(
              (t) => t.type === 'runquery' && t.connectionId === c.id && t.sql === q.sql
            )
              ? 'ya en la tarea'
              : undefined,
            build: () => [savedQueryStep(c, q, db)]
          }
        })
      }
    ]
  }
  // SQL libre: the connection itself (no database) or one of its databases.
  const items: Item[] = db
    ? []
    : [
        {
          key: `sql:${c.id}:`,
          icon: TASK_ICONS.runquery,
          title: `Nueva consulta en ${c.name}`,
          subtitle: 'Sin base de datos por defecto (usa nombres completos en el SQL)',
          build: () => [sqlStep(c, null)]
        }
      ]
  for (const name of databaseItems(c))
    items.push({
      key: `sql:${c.id}:${name}`,
      icon: TASK_ICONS.runquery,
      title: `Nueva consulta en ${name}`,
      subtitle: 'Escribe el SQL en los ajustes del paso',
      build: () => [sqlStep(c, name)]
    })
  return [{ key: 'sql', title: `SQL libre · ${db ?? c.name}`, items }]
})

function toggleChecked(key: string): void {
  checked.value = checked.value.includes(key)
    ? checked.value.filter((k) => k !== key)
    : [...checked.value, key]
}

/** «Seleccionar todo» of a list: every item checked, some, or none. */
function groupState(g: ItemGroup): 'all' | 'some' | 'none' {
  const fresh = g.items.filter((i) => !i.inJob)
  const pool = fresh.length ? fresh : g.items
  const n = g.items.filter((i) => checked.value.includes(i.key)).length
  return n === 0 ? 'none' : pool.every((i) => checked.value.includes(i.key)) ? 'all' : 'some'
}

function toggleGroup(g: ItemGroup): void {
  // Items already in the job are left out (unless every item is), so «Añadir» adds no repeats.
  const fresh = g.items.filter((i) => !i.inJob)
  const keys = (fresh.length ? fresh : g.items).map((i) => i.key)
  checked.value =
    groupState(g) === 'all'
      ? checked.value.filter((k) => !keys.includes(k))
      : [...checked.value, ...keys.filter((k) => !checked.value.includes(k))]
}

function addItems(items: Item[]): void {
  // «Todas las bases de datos» and one of them checked together add that copy once.
  const built = dedupeSteps(items.flatMap((i) => i.build()))
  if (built.length) emit('add', built)
  checked.value = []
}

/** Steps of the checked items: a package whose items are all checked is one package step. */
function checkedSteps(): JobTask[] {
  const out: JobTask[] = []
  for (const g of groups.value) {
    const picked = g.items.filter((i) => checked.value.includes(i.key))
    if (!picked.length) continue
    if (g.pack && picked.length === g.items.length) out.push(...g.pack.build())
    else if (g.pack?.buildSome) out.push(...g.pack.buildSome(picked))
    else out.push(...picked.flatMap((i) => i.build()))
  }
  return dedupeSteps(out)
}

function addChecked(): void {
  const built = checkedSteps()
  if (built.length) emit('add', built)
  checked.value = []
}

function addPack(g: ItemGroup): void {
  if (!g.pack) return
  emit('add', g.pack.build())
  checked.value = []
}

/** Package header: every item of the group checked, some, or none. */
function packState(g: ItemGroup): 'all' | 'some' | 'none' {
  const n = g.items.filter((i) => checked.value.includes(i.key)).length
  return n === 0 ? 'none' : n === g.items.length ? 'all' : 'some'
}

function togglePack(g: ItemGroup): void {
  const keys = g.items.map((i) => i.key)
  checked.value =
    packState(g) === 'all'
      ? checked.value.filter((k) => !keys.includes(k))
      : [...checked.value, ...keys.filter((k) => !checked.value.includes(k))]
}

function onPackKey(event: KeyboardEvent, g: ItemGroup): void {
  if (event.target !== event.currentTarget) return
  if (event.key === 'Enter') addPack(g)
  else if (event.key === ' ') togglePack(g)
  else if (event.key === 'ArrowLeft' && !isFolded(g)) toggleFold(g)
  else if (event.key === 'ArrowRight' && isFolded(g)) toggleFold(g)
  else return
  event.preventDefault()
}

function onPackDblClick(event: MouseEvent, g: ItemGroup): void {
  if ((event.target as HTMLElement | null)?.closest('.pack-head__check, .pack-head__fold')) return
  addPack(g)
}

function onPackDragStart(event: DragEvent, g: ItemGroup): void {
  if (!g.pack) return
  const pack = g.pack
  startAddDrag(() => pack.build())
  event.dataTransfer?.setData(ADD_DRAG_TYPE, pack.key)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
}

/** Number of steps «Añadir» adds (a whole package counts as one). */
const checkedCount = computed(() => (checked.value.length ? checkedSteps().length : 0))

function onItemKey(event: KeyboardEvent, item: Item): void {
  if (event.target !== event.currentTarget) return
  if (event.key === 'Enter') {
    addItems([item])
    event.preventDefault()
  } else if (event.key === ' ') {
    toggleChecked(item.key)
    event.preventDefault()
  }
}

/** Double click adds the item, except on its checkbox (two quick toggles). */
function onItemDblClick(event: MouseEvent, item: Item): void {
  if ((event.target as HTMLElement | null)?.closest('.avail-item__check')) return
  addItems([item])
}

function onItemDragStart(event: DragEvent, item: Item): void {
  startAddDrag(() =>
    checked.value.includes(item.key) ? checkedSteps() : dedupeSteps(item.build())
  )
  event.dataTransfer?.setData(ADD_DRAG_TYPE, item.key)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
}

/** Origin proposed to «Copiar y restaurar»: the selected connection, when it can back up. */
function openRecipe(): void {
  const c = connection.value
  emit('recipe', c && canBackup(c) ? c.id : null)
}

const emptyTree = computed(() =>
  kind.value === 'savedQuery' || kind.value === 'sql'
    ? 'Las consultas solo se ejecutan en conexiones MySQL y MariaDB, y no tienes ninguna.'
    : 'No hay conexiones que admitan tareas.'
)
</script>

<template>
  <section class="step-browser" aria-label="Añadir pasos" data-test="step-browser">
    <header class="step-browser__head">
      <h3 class="step-browser__title">
        <v-icon icon="mdi-plus-box-multiple-outline" size="16" aria-hidden="true" />Añadir pasos
      </h3>
      <div
        class="step-browser__kinds"
        role="group"
        aria-label="Tipo de paso"
        data-test="step-kinds"
      >
        <button
          v-for="k in STEP_KINDS"
          :key="k.value"
          type="button"
          class="step-kind nd-transition"
          :class="{ 'step-kind--active': kind === k.value }"
          :aria-pressed="kind === k.value"
          :data-test="`step-kind-${k.value}`"
          @click="((kind = k.value), (collapsed = false))"
        >
          <v-icon :icon="k.icon" size="15" aria-hidden="true" /><span class="step-kind__long">{{
            k.label
          }}</span
          ><span class="step-kind__short" aria-hidden="true">{{ k.short }}</span>
        </button>
      </div>
      <v-btn
        size="small"
        variant="tonal"
        color="primary"
        prepend-icon="mdi-database-sync-outline"
        class="step-browser__recipe step-browser__recipe--long"
        title="Copia bases de datos de una conexión y las restaura en otra en cada ejecución"
        data-test="browser-recipe"
        @click="openRecipe"
        >Copiar y restaurar</v-btn
      >
      <v-btn
        icon="mdi-database-sync-outline"
        size="x-small"
        variant="tonal"
        color="primary"
        class="step-browser__recipe step-browser__recipe--short"
        aria-label="Copiar y restaurar"
        title="Copiar y restaurar: copia bases de datos de una conexión y las restaura en otra en cada ejecución"
        data-test="browser-recipe-short"
        @click="openRecipe"
      />
      <v-btn
        :icon="collapsed ? 'mdi-chevron-up' : 'mdi-chevron-down'"
        size="x-small"
        variant="text"
        class="step-browser__fold"
        :aria-label="collapsed ? 'Mostrar «Añadir pasos»' : 'Ocultar «Añadir pasos»'"
        :title="collapsed ? 'Mostrar' : 'Ocultar'"
        :aria-expanded="!collapsed"
        data-test="step-browser-fold"
        @click="collapsed = !collapsed"
      />
    </header>
    <div v-show="!collapsed" class="step-browser__body">
      <div class="step-browser__tree" data-test="step-browser-tree">
        <v-text-field
          v-model="filter"
          density="compact"
          hide-details
          clearable
          placeholder="Filtrar conexiones o bases de datos"
          prepend-inner-icon="mdi-magnify"
          aria-label="Filtrar conexiones o bases de datos"
          class="step-browser__filter"
          data-test="step-browser-filter"
        />
        <p v-if="!kindConnections.length" class="step-browser__muted">{{ emptyTree }}</p>
        <ul v-else class="browse-tree" aria-label="Conexiones">
          <li v-for="c in filteredConnections" :key="c.id">
            <div
              class="browse-node"
              :class="{ 'browse-node--selected': selectedConnection === c.id && !selectedDatabase }"
            >
              <button
                type="button"
                class="browse-node__chevron"
                :aria-label="expanded[c.id] ? `Contraer ${c.name}` : `Expandir ${c.name}`"
                :aria-expanded="!!expanded[c.id]"
                :data-test="`browse-expand-${c.id}`"
                @click="toggle(c)"
              >
                <v-progress-circular
                  v-if="schemaLoader.isLoading(c.id)"
                  indeterminate
                  size="12"
                  width="2"
                />
                <v-icon
                  v-else
                  :icon="expanded[c.id] ? 'mdi-chevron-down' : 'mdi-chevron-right'"
                  size="16"
                />
              </button>
              <button
                type="button"
                class="browse-node__label"
                :aria-pressed="selectedConnection === c.id && !selectedDatabase"
                :data-test="`browse-connection-${c.id}`"
                @click="selectConnection(c)"
                @dblclick="toggle(c)"
                @keydown="onConnectionKey($event, c)"
              >
                <v-icon
                  :icon="engineOf(c).icon"
                  size="15"
                  class="browse-node__icon"
                  aria-hidden="true"
                />
                <span class="browse-node__name">{{ c.name }}</span>
                <span
                  v-if="c.environment !== 'other'"
                  class="nd-pill browse-node__env"
                  :class="ENV_PILL[c.environment]"
                  >{{ ENVIRONMENT_LABELS[c.environment] }}</span
                >
              </button>
            </div>
            <ul
              v-if="expanded[c.id]"
              class="browse-tree__children"
              :aria-label="`Bases de datos de ${c.name}`"
            >
              <li v-if="schemaLoader.errorOf(c.id)" class="browse-node__error">
                {{ schemaLoader.errorOf(c.id) }}
              </li>
              <li v-for="name in databasesOf(c)" :key="name">
                <button
                  type="button"
                  class="browse-node browse-node--db browse-node__label"
                  :class="{
                    'browse-node--selected':
                      selectedConnection === c.id && selectedDatabase === name
                  }"
                  :aria-pressed="selectedConnection === c.id && selectedDatabase === name"
                  :data-test="`browse-db-${name}`"
                  @click="selectDatabase(c, name)"
                >
                  <v-icon
                    icon="mdi-database-outline"
                    size="14"
                    class="browse-node__icon"
                    aria-hidden="true"
                  />
                  <span class="browse-node__name">{{ name }}</span>
                  <span
                    v-if="
                      kind === 'savedQuery' && queries.list(c.id).some((q) => q.schema === name)
                    "
                    class="browse-node__count"
                    >{{ queries.list(c.id).filter((q) => q.schema === name).length }}</span
                  >
                </button>
              </li>
            </ul>
          </li>
        </ul>
      </div>

      <div class="step-browser__items" data-test="step-browser-items">
        <p v-if="!groups.length" class="step-browser__placeholder">
          <v-icon icon="mdi-gesture-tap" size="18" aria-hidden="true" />
          Elige una conexión o una base de datos para ver lo que puedes añadir.
        </p>
        <template v-for="g in groups" :key="g.key">
          <h4 v-if="g.heading !== null" class="step-browser__group">
            {{ g.heading ?? g.title
            }}<span v-if="g.note" class="step-browser__group-note"> · {{ g.note }}</span>
          </h4>
          <div
            v-if="g.pack"
            class="pack-head nd-transition"
            :class="{
              'pack-head--checked': packState(g) === 'all',
              'pack-head--folded': isFolded(g)
            }"
            tabindex="0"
            draggable="true"
            :aria-label="`${g.pack.title}. ${g.pack.subtitle}. Intro para añadir el paquete como un paso, espacio para marcar sus copias.`"
            :aria-expanded="!isFolded(g)"
            :data-test="`avail-${g.pack.key}`"
            @dblclick="onPackDblClick($event, g)"
            @keydown="onPackKey($event, g)"
            @dragstart="onPackDragStart($event, g)"
            @dragend="endAddDrag"
          >
            <button
              type="button"
              class="pack-head__fold"
              tabindex="-1"
              :aria-label="
                isFolded(g)
                  ? `Mostrar las copias de ${g.title}`
                  : `Ocultar las copias de ${g.title}`
              "
              :title="isFolded(g) ? 'Mostrar las copias' : 'Ocultar las copias'"
              :data-test="`pack-fold-${g.key}`"
              @click.stop="toggleFold(g)"
            >
              <v-icon :icon="isFolded(g) ? 'mdi-chevron-right' : 'mdi-chevron-down'" size="16" />
            </button>
            <v-checkbox-btn
              :model-value="packState(g) === 'all'"
              :indeterminate="packState(g) === 'some'"
              density="compact"
              tabindex="-1"
              class="pack-head__check"
              :aria-label="`Marcar todo el paquete: ${g.title}`"
              :data-test="`pack-check-${g.key}`"
              @update:model-value="togglePack(g)"
            />
            <v-icon
              icon="mdi-package-variant-closed"
              size="18"
              class="pack-head__icon"
              aria-hidden="true"
            />
            <span class="pack-head__text">
              <span class="pack-head__title">{{ g.pack.title }}</span>
              <span class="pack-head__route">
                <span v-for="p in g.pack.sources" :key="p.id" class="pack-pill">
                  <v-icon :icon="p.icon" size="12" aria-hidden="true" />{{ p.name }}
                  <span
                    v-if="p.environment !== 'other'"
                    class="nd-pill pack-pill__env"
                    :class="ENV_PILL[p.environment]"
                    >{{ ENVIRONMENT_LABELS[p.environment] }}</span
                  >
                </span>
                <v-icon
                  icon="mdi-arrow-right"
                  size="13"
                  class="pack-head__arrow"
                  aria-hidden="true"
                />
                <span v-if="g.pack.target" class="pack-pill pack-pill--target">
                  <v-icon :icon="g.pack.target.icon" size="12" aria-hidden="true" />{{
                    g.pack.target.name
                  }}
                  <span
                    v-if="g.pack.target.environment !== 'other'"
                    class="nd-pill pack-pill__env"
                    :class="ENV_PILL[g.pack.target.environment]"
                    >{{ ENVIRONMENT_LABELS[g.pack.target.environment] }}</span
                  >
                </span>
                <span v-else class="pack-pill pack-pill--missing">elige el destino</span>
              </span>
              <span class="pack-head__sub" :title="g.pack.subtitle">{{ g.pack.subtitle }}</span>
            </span>
            <span v-if="g.pack.inJob" class="nd-pill nd-pill--info avail-item__pill">{{
              g.pack.inJob
            }}</span>
            <v-btn
              icon="mdi-plus"
              size="x-small"
              variant="tonal"
              class="pack-head__add"
              :aria-label="`Añadir ${g.pack.title} como un paso`"
              title="Añadir el paquete como un paso «Restaurar paquete»"
              tabindex="-1"
              :data-test="`avail-add-${g.pack.key}`"
              @click.stop="addPack(g)"
            />
          </div>
          <div
            v-if="!g.items.length && g.recipe"
            class="step-browser__suggest"
            data-test="browser-recipe-suggest"
          >
            <v-icon icon="mdi-lightbulb-on-outline" size="18" aria-hidden="true" />
            <div class="step-browser__suggest-text">
              <strong>Esta tarea aún no hace copias.</strong>
              <span
                >Para copiar las bases de datos de una conexión (p. ej. Staging) y restaurarlas en
                otra (p. ej. Local) en cada ejecución, con o sin copia previa del destino, usa
                «Copiar y restaurar».</span
              >
            </div>
            <v-btn
              size="small"
              color="primary"
              variant="flat"
              prepend-icon="mdi-database-sync-outline"
              data-test="browser-recipe-suggest-open"
              @click="openRecipe"
              >Copiar y restaurar…</v-btn
            >
          </div>
          <p v-else-if="!g.items.length" class="step-browser__muted">{{ g.empty }}</p>
          <v-checkbox
            v-if="g.items.length > 1 && !g.noSelectAll && !g.pack"
            :model-value="groupState(g) === 'all'"
            :indeterminate="groupState(g) === 'some'"
            density="compact"
            hide-details
            class="step-browser__all"
            :aria-label="`Seleccionar todo: ${g.title}`"
            :data-test="`browser-select-all-${g.key}`"
            @update:model-value="toggleGroup(g)"
          >
            <template #label
              ><span class="step-browser__all-label"
                >Seleccionar todo
                <span class="step-browser__all-count"
                  >({{ g.items.filter((i) => checked.includes(i.key)).length }}/{{
                    g.items.length
                  }})</span
                ></span
              ></template
            >
          </v-checkbox>
          <ul
            v-if="g.items.length && !(g.collapsible && g.pack && isFolded(g))"
            class="avail-list"
            :class="{ 'avail-list--nested': !!g.pack }"
            :aria-label="g.title"
          >
            <li
              v-for="item in g.items"
              :key="item.key"
              class="avail-item nd-transition"
              :class="{ 'avail-item--checked': checked.includes(item.key) }"
              tabindex="0"
              draggable="true"
              :aria-label="`${item.title}. ${item.subtitle}. Intro para añadir, espacio para marcar.`"
              :data-test="`avail-${item.key}`"
              @dblclick="onItemDblClick($event, item)"
              @keydown="onItemKey($event, item)"
              @dragstart="onItemDragStart($event, item)"
              @dragend="endAddDrag"
            >
              <v-checkbox-btn
                :model-value="checked.includes(item.key)"
                density="compact"
                :aria-label="`Marcar ${item.title}`"
                tabindex="-1"
                class="avail-item__check"
                @update:model-value="toggleChecked(item.key)"
              />
              <v-icon :icon="item.icon" size="16" class="avail-item__icon" aria-hidden="true" />
              <span class="avail-item__text">
                <span class="avail-item__title">{{ item.title }}</span>
                <span class="avail-item__sub" :class="{ 'nd-mono': item.mono }">{{
                  item.subtitle
                }}</span>
              </span>
              <span v-if="item.inJob" class="nd-pill nd-pill--info avail-item__pill">{{
                item.inJob
              }}</span>
              <v-btn
                icon="mdi-plus"
                size="x-small"
                variant="tonal"
                class="avail-item__add"
                :aria-label="`Añadir ${item.title}`"
                title="Añadir a la secuencia"
                tabindex="-1"
                :data-test="`avail-add-${item.key}`"
                @click.stop="addItems([item])"
              />
            </li>
          </ul>
        </template>
      </div>
    </div>
    <footer v-show="!collapsed" class="step-browser__foot">
      <span class="step-browser__hint">{{ kindMeta.hint }}</span>
      <v-btn
        size="small"
        color="primary"
        variant="flat"
        prepend-icon="mdi-playlist-plus"
        :disabled="!checkedCount"
        data-test="browser-add"
        @click="addChecked"
      >
        Añadir{{ checkedCount ? ` (${checkedCount})` : '' }}
      </v-btn>
    </footer>
  </section>
</template>

<style scoped>
.step-browser {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.step-browser__recipe--short {
  display: none;
}
.step-browser__recipe {
  margin-left: auto;
  flex: none;
  text-transform: none;
  letter-spacing: 0;
}
.step-browser__group-note {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
}
.step-browser__all {
  margin: -2px 0 2px;
  padding-left: 2px;
}
.step-browser__all-label {
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.step-browser__all-count {
  color: var(--nd-text-muted);
  font-size: var(--nd-fs-xs);
}
.step-browser__suggest {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 4px 0 10px;
  padding: 10px 12px;
  border: 1px solid rgba(var(--nd-accent-rgb), 0.35);
  border-radius: var(--nd-radius-control);
  background: rgba(var(--nd-accent-rgb), 0.07);
}
.step-browser__suggest > .v-icon {
  flex: none;
  color: var(--nd-accent);
}
.step-browser__suggest-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.step-browser__suggest-text strong {
  font-size: var(--nd-fs-dense);
  color: var(--nd-text);
}
.step-browser__head {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 8px 14px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--nd-hairline);
}
.step-browser__title {
  flex: none;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--nd-fs-dense);
  font-weight: var(--nd-fw-heading);
}
.step-browser__title .v-icon {
  color: var(--nd-accent);
}
.step-browser__kinds {
  display: inline-flex;
  flex-wrap: nowrap;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
  gap: 2px;
  padding: 2px;
  border-radius: var(--nd-radius-pill);
  background: var(--nd-bg-sunken);
  border: 1px solid var(--nd-border);
}
.step-kind {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 11px;
  border-radius: var(--nd-radius-pill);
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
}
.step-kind__short {
  display: none;
}
.step-kind:hover {
  color: var(--nd-text);
  background: var(--nd-hover);
}
.step-kind:focus-visible {
  outline: 2px solid rgba(var(--nd-accent-rgb), 0.6);
  outline-offset: 1px;
}
.step-kind--active {
  color: var(--nd-text);
  background: var(--nd-bg-raised);
  border-color: rgba(var(--nd-accent-rgb), 0.45);
  box-shadow: var(--nd-shadow-1);
}
.step-kind--active .v-icon {
  color: var(--nd-accent);
}
.step-browser__body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(200px, 34%) minmax(0, 1fr);
}
.step-browser__tree {
  min-height: 0;
  overflow-y: auto;
  padding: 8px 6px 8px 10px;
  border-right: 1px solid var(--nd-hairline);
}
.step-browser__filter {
  margin-bottom: 6px;
}
.browse-tree,
.browse-tree__children {
  list-style: none;
  margin: 0;
  padding: 0;
}
.browse-tree__children {
  padding-left: 22px;
}
.browse-node {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 26px;
  border-radius: var(--nd-radius-sm);
}
.browse-node__chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 22px;
  color: var(--nd-text-muted);
  background: none;
  border: 0;
  cursor: pointer;
  border-radius: var(--nd-radius-sm);
}
.browse-node__label {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 6px;
  font: inherit;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text);
  background: none;
  border: 0;
  border-radius: var(--nd-radius-sm);
  cursor: pointer;
  text-align: left;
}
.browse-node--db {
  width: 100%;
}
.browse-node__label:hover {
  background: var(--nd-hover);
}
.browse-node__label:focus-visible,
.browse-node__chevron:focus-visible {
  outline: 2px solid rgba(var(--nd-accent-rgb), 0.6);
  outline-offset: -2px;
}
.browse-node--selected > .browse-node__label,
.browse-node--selected.browse-node__label {
  background: var(--nd-selected);
  box-shadow: inset 2px 0 0 var(--nd-accent);
}
.browse-node__icon {
  color: var(--nd-text-2);
  flex: none;
}
.browse-node__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.browse-node__env {
  margin-left: auto;
  flex: none;
  height: 16px;
  padding: 0 6px;
}
.browse-node__count {
  margin-left: auto;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
}
.browse-node__error {
  padding: 4px 6px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-error);
}
.step-browser__items {
  min-height: 0;
  overflow-y: auto;
  padding: 6px 12px 10px;
}
.step-browser__group {
  margin: 8px 0 6px;
  font-size: var(--nd-fs-xs);
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--nd-text-muted);
}
.step-browser__placeholder {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 18px 4px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.step-browser__muted {
  margin: 4px 2px 8px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.avail-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.avail-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 3px 6px 3px 2px;
  border-radius: var(--nd-radius-control);
  border: 1px solid transparent;
  cursor: grab;
  outline: none;
  user-select: none;
}
.avail-item:hover {
  background: var(--nd-hover);
  border-color: var(--nd-border);
}
.avail-item:focus-visible {
  box-shadow: 0 0 0 2px rgba(var(--nd-accent-rgb), 0.55);
}
.avail-item--checked {
  background: var(--nd-selected);
  border-color: rgba(var(--nd-accent-rgb), 0.4);
}
.avail-item__check {
  flex: none;
}
.avail-item__icon {
  color: var(--nd-text-2);
  flex: none;
}
.avail-item__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.avail-item__title {
  font-size: var(--nd-fs-dense);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.avail-item__sub {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.avail-item__pill {
  flex: none;
}
.avail-item__add {
  flex: none;
  opacity: 0;
}
.avail-item:hover .avail-item__add,
.avail-item:focus-visible .avail-item__add,
.avail-item--checked .avail-item__add {
  opacity: 1;
}
.pack-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 2px 0 3px;
  padding: 5px 6px 5px 2px;
  border-radius: var(--nd-radius-control);
  border: 1px solid var(--nd-border);
  background: var(--nd-bg-raised);
  cursor: grab;
  outline: none;
  user-select: none;
}
.pack-head + .pack-head,
.avail-list--nested + .pack-head {
  margin-top: 8px;
}
.pack-head:hover {
  border-color: rgba(var(--nd-accent-rgb), 0.45);
}
.pack-head:focus-visible {
  box-shadow: 0 0 0 2px rgba(var(--nd-accent-rgb), 0.55);
}
.pack-head--checked {
  background: var(--nd-selected);
  border-color: rgba(var(--nd-accent-rgb), 0.45);
}
.pack-head__fold {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 24px;
  color: var(--nd-text-muted);
  background: none;
  border: 0;
  border-radius: var(--nd-radius-sm);
  cursor: pointer;
}
.pack-head__fold:hover {
  color: var(--nd-text);
  background: var(--nd-hover);
}
.pack-head__check {
  flex: none;
}
.pack-head__icon {
  flex: none;
  color: var(--nd-accent);
}
.pack-head__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pack-head__title {
  font-size: var(--nd-fs-dense);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pack-head__route {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}
.pack-head__arrow {
  color: var(--nd-text-muted);
}
.pack-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--nd-radius-pill);
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  background: var(--nd-bg-sunken);
  border: 1px solid var(--nd-border);
  white-space: nowrap;
}
.pack-pill--target {
  color: var(--nd-text);
  border-color: rgba(var(--nd-accent-rgb), 0.4);
}
.pack-pill--missing {
  color: var(--nd-warning, var(--nd-text-2));
  border-style: dashed;
}
.pack-pill__env {
  height: 14px;
  padding: 0 5px;
  font-size: 10px;
}
.pack-head__sub {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pack-head__add {
  flex: none;
}
.avail-list--nested {
  margin-left: 22px;
  padding-left: 8px;
  border-left: 1px solid var(--nd-hairline);
}
.step-browser__foot {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 12px;
  border-top: 1px solid var(--nd-hairline);
}
.step-browser__hint {
  flex: 1;
  min-width: 0;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
/* Narrow editors: the kinds keep one line (title hidden, tighter pills), the tree narrows. */
@container (max-width: 720px) {
  .step-browser__title {
    display: none;
  }
  .step-kind {
    padding: 0 8px;
  }
  .step-kind__long {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
  .step-kind__short {
    display: inline;
  }
  .step-browser__body {
    grid-template-columns: minmax(160px, 42%) minmax(0, 1fr);
  }
  .step-browser__recipe--long {
    display: none;
  }
  .step-browser__recipe--short {
    display: inline-flex;
  }
}
@container (max-width: 520px) {
  .step-browser__suggest {
    flex-wrap: wrap;
  }
}
</style>
