<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  onUpdated,
  ref,
  shallowRef,
  watch
} from 'vue'
import type { JobRun } from '@shared/types'
import { useNotify } from '@renderer/composables/useNotify'
import { useJobLogsStore } from '@renderer/stores/jobLogs'
import { formatDate } from '@renderer/utils/format'
import { revealInFinder } from '@renderer/components/backups/reveal'
import RunLogChunk from './RunLogChunk.vue'
import StatusPill from './StatusPill.vue'
import { RunLogModel, type LogChunk, type LogRow } from './runLogModel'

/**
 * Navicat-style run log: a heading per step/database, one line per backed up
 * object, the step result and a final summary. Fills in live while the run
 * is active (event:jobLog) and reads the persisted file for past runs.
 *
 * Logs reach 20k lines, so lines are parsed incrementally (RunLogModel) and
 * rendered in blocks of 100: only blocks near the viewport are in the DOM
 * (the rest are spacers sized from measured or estimated heights) and a new
 * batch only patches the block that grew.
 */
const props = withDefaults(defineProps<{ run: JobRun | null; closable?: boolean }>(), {
  closable: true
})
const emit = defineEmits<{ close: [] }>()

const logs = useJobLogsStore()
const notify = useNotify()
const scroller = ref<HTMLElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
/** Auto-scroll; paused while the user reads earlier lines. */
const follow = ref(true)

/** Distance from the bottom (px) under which the view keeps following new lines. */
const FOLLOW_SLACK = 24
/** Height estimates until a block is measured: 12px * 1.55 line height, headings are taller. */
const LINE_PX = 18.6
const HEADING_EXTRA_PX = 17
/** Rendered margin above and below the viewport. */
const OVERSCAN_PX = 800
/** Logs with this many blocks or fewer are rendered whole. */
const ALWAYS_RENDER_CHUNKS = 3

const buffer = computed(() => logs.get(props.run?.id))
const model = new RunLogModel()
const chunks = shallowRef<LogChunk[]>([])
const summary = shallowRef<LogRow[]>([])
const lineCount = ref(0)

/** Measured block heights (px) by block key; `layoutRev` publishes changes. */
const heights = new Map<number, number>()
const layoutRev = ref(0)
const scrollTop = ref(0)
const viewport = ref(0)

function syncModel(): void {
  const buf = buffer.value
  if (!buf) {
    model.reset()
  } else {
    model.sync(buf.offset, buf.lines, buf.generation)
  }
  chunks.value = model.chunks()
  summary.value = model.summary()
  lineCount.value = model.size
}

const summaryTone = computed(() => {
  const final = summary.value.find((l) => l.kind === 'final')
  return final?.tone ?? (props.run?.status === 'success' ? 'ok' : 'error')
})
const live = computed(() => props.run?.status === 'running' || props.run?.status === 'queued')
const empty = computed(
  () => !buffer.value?.loading && !buffer.value?.error && lineCount.value === 0
)

function heightOf(chunk: LogChunk): number {
  return heights.get(chunk.key) ?? chunk.rows.length * LINE_PX + chunk.headings * HEADING_EXTRA_PX
}

/** Blocks to render plus the spacer heights around them. */
const windowed = computed(() => {
  void layoutRev.value
  const list = chunks.value
  if (list.length <= ALWAYS_RENDER_CHUNKS) return { items: list, before: 0, after: 0 }
  const tops: number[] = []
  let total = 0
  for (const chunk of list) {
    tops.push(total)
    total += heightOf(chunk)
  }
  const listTop = listEl.value?.offsetTop ?? 0
  const view = follow.value
    ? Math.max(0, total - viewport.value)
    : Math.max(0, scrollTop.value - listTop)
  let first = 0
  while (first < list.length - 1 && tops[first] + heightOf(list[first]) < view - OVERSCAN_PX)
    first++
  let last = first
  while (last < list.length - 1 && tops[last + 1] <= view + viewport.value + OVERSCAN_PX) last++
  if (follow.value) last = list.length - 1
  const after = total - (tops[last] + heightOf(list[last]))
  return { items: list.slice(first, last + 1), before: tops[first], after: Math.max(0, after) }
})

let observer: ResizeObserver | null = null
let measureFrame = 0
const observed = new Set<Element>()
/** Blocks resized since the last frame. */
const resized = new Set<Element>()

function measure(el: Element): boolean {
  const key = Number((el as HTMLElement).dataset.chunk)
  const height = (el as HTMLElement).offsetHeight
  if (!Number.isFinite(key) || height <= 0) return false
  if (Math.abs((heights.get(key) ?? -1) - height) < 0.5) return false
  heights.set(key, height)
  return true
}

/** Applies resized blocks on the next frame (changing spacers inside the observer callback loops). */
function onResize(entries: ResizeObserverEntry[]): void {
  for (const entry of entries) resized.add(entry.target)
  if (measureFrame) return
  measureFrame = requestAnimationFrame(() => {
    measureFrame = 0
    let changed = false
    for (const el of resized) if (el.isConnected && measure(el)) changed = true
    resized.clear()
    if (changed) layoutRev.value++
  })
}

/** Watches the rendered blocks so spacers use real heights (wrapped lines, headings). */
function observeChunks(): void {
  const blocks = listEl.value?.querySelectorAll('[data-chunk]') ?? []
  let changed = false
  if (observer) {
    // Blocks scrolled out of the window were removed from the DOM: stop observing them.
    for (const el of observed)
      if (!el.isConnected) {
        observer.unobserve(el)
        observed.delete(el)
      }
  }
  for (const el of blocks) {
    if (observer) {
      if (!observed.has(el)) {
        observer.observe(el)
        observed.add(el)
      }
    } else if (measure(el)) changed = true
  }
  if (changed) layoutRev.value++
}

function readScroll(): void {
  const el = scroller.value
  if (!el) return
  scrollTop.value = el.scrollTop
  viewport.value = el.clientHeight
}

function onScroll(): void {
  const el = scroller.value
  if (!el) return
  follow.value = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK
  readScroll()
}

function scrollToEnd(): void {
  const el = scroller.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  follow.value = true
  readScroll()
}

async function copy(): Promise<void> {
  const text = (buffer.value?.lines ?? []).join('\n')
  try {
    await navigator.clipboard.writeText(text)
    notify.success('Registro copiado al portapapeles')
  } catch {
    notify.error('No se pudo copiar al portapapeles')
  }
}

watch(
  () => props.run?.id,
  (id) => {
    follow.value = true
    model.reset()
    heights.clear()
    syncModel()
    if (id) void logs.ensure(id).then(() => nextTick(scrollToEnd))
  },
  { immediate: true }
)

// New lines: parse only what arrived and keep the end in view unless the user scrolled up.
watch(
  () => [buffer.value?.rev, buffer.value?.generation, buffer.value] as const,
  async () => {
    syncModel()
    if (!follow.value) return
    await nextTick()
    scrollToEnd()
  }
)

// Real heights replace the estimates: stay at the end while following.
watch(layoutRev, async () => {
  if (!follow.value) return
  await nextTick()
  scrollToEnd()
})

// The final status arrives after the last lines: re-read the file once to be exhaustive.
watch(
  () => props.run?.status,
  (status, previous) => {
    const id = props.run?.id
    if (id && previous === 'running' && status !== 'running' && !buffer.value?.complete)
      void logs.load(id)
  }
)

onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') observer = new ResizeObserver(onResize)
  readScroll()
  observeChunks()
})
onUpdated(observeChunks)
onBeforeUnmount(() => {
  observer?.disconnect()
  observed.clear()
  cancelAnimationFrame(measureFrame)
})

defineExpose({ follow, scrollToEnd })
</script>

<template>
  <section class="run-log" aria-label="Registro de la ejecución" data-test="run-log-panel">
    <header class="run-log__head">
      <v-icon icon="mdi-text-box-outline" size="16" class="run-log__icon" aria-hidden="true" />
      <span class="run-log__title">Registro</span>
      <span v-if="run" class="run-log__subtitle nd-ellipsis" :title="run.jobName"
        >{{ run.jobName }} · <span class="nd-mono">{{ formatDate(run.startedAt) }}</span></span
      >
      <StatusPill v-if="run" :status="run.status" data-test="run-log-status" />
      <v-spacer />
      <v-btn
        v-if="!follow"
        size="x-small"
        variant="tonal"
        prepend-icon="mdi-arrow-collapse-down"
        data-test="run-log-follow"
        @click="scrollToEnd"
        >Ir al final</v-btn
      >
      <v-btn
        size="x-small"
        variant="text"
        prepend-icon="mdi-content-copy"
        :disabled="!buffer?.lines.length"
        data-test="run-log-copy"
        @click="copy"
        >Copiar</v-btn
      >
      <v-btn
        size="x-small"
        variant="text"
        prepend-icon="mdi-folder-open-outline"
        :disabled="!run || buffer?.missing"
        :title="run ? `Mostrar en Finder: ${run.logPath}` : undefined"
        data-test="run-log-reveal"
        @click="revealInFinder(run?.logPath)"
        >Mostrar en Finder</v-btn
      >
      <v-btn
        v-if="closable"
        icon="mdi-close"
        size="x-small"
        variant="text"
        aria-label="Cerrar registro"
        title="Cerrar registro"
        data-test="run-log-close"
        @click="emit('close')"
      />
    </header>
    <div
      ref="scroller"
      class="run-log__body"
      tabindex="0"
      data-test="run-log-body"
      @scroll.passive="onScroll"
    >
      <div v-if="buffer?.loading && !lineCount" class="run-log__note">Cargando registro…</div>
      <div v-else-if="buffer?.error" class="run-log__note run-log__note--error">
        {{ buffer.error }}
      </div>
      <div v-else-if="empty" class="run-log__note">
        {{ buffer?.missing ? 'Esta ejecución no tiene registro.' : 'Sin líneas todavía.' }}
      </div>
      <div v-if="buffer?.offset" class="run-log__note" data-test="run-log-trimmed">
        Se ocultan las {{ buffer.offset.toLocaleString('es') }} primeras líneas; el archivo de
        registro está completo.
      </div>
      <div ref="listEl" class="run-log__list">
        <div
          v-if="windowed.before"
          class="run-log__spacer"
          :style="{ height: `${windowed.before}px` }"
          aria-hidden="true"
        />
        <RunLogChunk
          v-for="chunk in windowed.items"
          :key="chunk.key"
          :rows="chunk.rows"
          :data-chunk="chunk.key"
        />
        <div
          v-if="windowed.after"
          class="run-log__spacer"
          :style="{ height: `${windowed.after}px` }"
          aria-hidden="true"
        />
      </div>
      <div v-if="live" class="run-log__live" data-test="run-log-live">
        <span class="run-log__cursor" aria-hidden="true" />En curso…
      </div>
      <div
        v-if="summary.length"
        class="run-log__summary"
        :class="`run-log__summary--${summaryTone}`"
        data-test="run-log-summary"
      >
        <RunLogChunk :rows="summary" line-test="run-log-summary-line" plain-rest />
      </div>
    </div>
  </section>
</template>

<style scoped>
.run-log {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--nd-bg-panel);
}
.run-log__head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 40px;
  padding: 0 8px 0 14px;
  border-bottom: 1px solid var(--nd-border);
  flex: none;
  overflow: hidden;
}
.run-log__head > .v-btn {
  flex: none;
}
.run-log__icon {
  color: var(--nd-text-muted);
}
.run-log__title {
  font-weight: var(--nd-fw-heading);
  flex: none;
}
.run-log__subtitle {
  min-width: 0;
  color: var(--nd-text-2);
  font-size: var(--nd-fs-dense);
}
.run-log__body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 0 12px;
  background: var(--nd-bg-sunken);
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
  font-variant-ligatures: none;
  line-height: 1.55;
  color: var(--nd-text);
}
.run-log__body:focus-visible {
  outline: 1px solid rgba(var(--nd-accent-rgb), 0.5);
  outline-offset: -1px;
}
.run-log__note {
  padding: 4px 14px;
  font-family: var(--nd-font-ui);
  color: var(--nd-text-muted);
}
.run-log__note--error {
  color: var(--nd-error);
}
.run-log__live {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 14px;
  color: var(--nd-info);
}
.run-log__cursor {
  width: 7px;
  height: 13px;
  background: var(--nd-info);
  animation: run-log-blink 1s steps(2) infinite;
}
@keyframes run-log-blink {
  50% {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .run-log__cursor {
    animation: none;
  }
}
.run-log__summary {
  --tone: var(--nd-success);
  margin: 12px 14px 0;
  padding: 8px 0;
  border-radius: var(--nd-radius-control);
  border: 1px solid color-mix(in srgb, var(--tone) 40%, transparent);
  background: color-mix(in srgb, var(--tone) 9%, transparent);
}
.run-log__summary--error {
  --tone: var(--nd-error);
}
.run-log__summary--cancelled,
.run-log__summary--skipped {
  --tone: var(--nd-warning);
}
.run-log__summary :deep(.run-log__line--summary:first-child) {
  font-weight: 700;
}
.run-log__summary :deep(.run-log__line--final) {
  margin-top: 4px;
  font-weight: 700;
  color: var(--tone);
}
</style>
