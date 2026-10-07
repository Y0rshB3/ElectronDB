<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useTourStore } from '@renderer/stores/tour'
import {
  findTourTarget,
  placeCard,
  prefersReducedMotion,
  spotlightBox,
  type Box,
  type CardPosition
} from './tourLayout'

/**
 * Coach marks of the guided tours: dims the app, rings the target element
 * (`data-tour="…"`) and shows a small card next to it. A missing or hidden
 * target only centres the card. Esc skips, ←/→ navigate, Tab stays in the card.
 */
const tour = useTourStore()

const card = ref<HTMLElement | null>(null)
const spot = ref<Box | null>(null)
const position = ref<CardPosition>({ top: 0, left: 0, placement: 'center' })
const reducedMotion = ref(false)

const step = computed(() => tour.step)
const counter = computed(() => `Paso ${tour.index + 1} de ${tour.steps.length}`)
const hasActions = computed(() => !!step.value?.actions?.length)
/** Last step: the real choices on their own row, «Ahora no» next to «Atrás». */
const mainActions = computed(() => step.value?.actions?.filter((a) => a.variant !== 'text') ?? [])
const dismissActions = computed(
  () => step.value?.actions?.filter((a) => a.variant === 'text') ?? []
)
const ariaLabel = computed(() =>
  tour.kind === 'welcome' ? 'Tour de bienvenida' : 'Cómo usar las novedades'
)

/** Text split around the monospace part (a folder path), if any. */
const textParts = computed(() => {
  const s = step.value
  if (!s) return null
  if (!s.code || !s.text.includes(s.code)) return { before: s.text, code: '', after: '' }
  const at = s.text.indexOf(s.code)
  return {
    before: s.text.slice(0, at),
    code: s.code,
    after: s.text.slice(at + s.code.length)
  }
})

function viewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight }
}

function layout(): void {
  const s = step.value
  if (!s) return
  const el = findTourTarget(s.target)
  const vp = viewport()
  const rect = el?.getBoundingClientRect() ?? null
  const target: Box | null = rect
    ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
    : null
  spot.value = target ? spotlightBox(target, vp) : null
  const size = card.value?.getBoundingClientRect()
  position.value = placeCard(
    spot.value,
    { width: size?.width || 360, height: size?.height || 180 },
    vp
  )
}

async function relayout(scroll: boolean): Promise<void> {
  await nextTick()
  const s = step.value
  if (!s) return
  if (scroll) {
    const el = findTourTarget(s.target)
    el?.scrollIntoView?.({
      block: 'nearest',
      inline: 'nearest',
      behavior: reducedMotion.value ? 'auto' : 'smooth'
    })
  }
  layout()
  // Second pass once the card has its real size.
  requestAnimationFrame(() => layout())
}

let previousFocus: HTMLElement | null = null

function focusCard(): void {
  const el = card.value
  if (!el) return
  const primary =
    el.querySelector<HTMLElement>('[data-tour-primary]') ?? el.querySelector<HTMLElement>('button')
  ;(primary ?? el).focus()
}

function focusables(): HTMLElement[] {
  return card.value ? [...card.value.querySelectorAll<HTMLElement>('button:not([disabled])')] : []
}

function onKeydown(event: KeyboardEvent): void {
  if (!tour.active) return
  switch (event.key) {
    case 'Escape':
      tour.skip()
      break
    case 'ArrowRight':
      if (hasActions.value) return
      tour.next()
      break
    case 'ArrowLeft':
      tour.prev()
      break
    case 'Tab': {
      const items = focusables()
      if (!items.length) break
      const current = items.indexOf(document.activeElement as HTMLElement)
      const nextIndex = event.shiftKey
        ? current <= 0
          ? items.length - 1
          : current - 1
        : current === items.length - 1
          ? 0
          : current + 1
      items[nextIndex].focus()
      break
    }
    default:
      return
  }
  // The tour owns the keyboard while it is open (no app shortcuts behind it).
  event.preventDefault()
  event.stopPropagation()
}

const onResize = (): void => layout()

function attach(): void {
  reducedMotion.value = prefersReducedMotion()
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('resize', onResize)
  window.addEventListener('scroll', onResize, true)
}

function detach(): void {
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('scroll', onResize, true)
  // Only give focus back when nothing else (an opened dialog) took it.
  const target = previousFocus
  previousFocus = null
  if (target?.isConnected && (document.activeElement === document.body || !document.activeElement))
    target.focus()
}

watch(
  () => tour.active,
  (on) => {
    if (on) attach()
    else detach()
  },
  { immediate: true }
)

watch(
  () => (tour.active ? tour.index : -1),
  async (i) => {
    if (i < 0) return
    await relayout(true)
    focusCard()
  },
  { immediate: true }
)

onBeforeUnmount(detach)

const spotStyle = computed(() =>
  spot.value
    ? {
        top: `${spot.value.top}px`,
        left: `${spot.value.left}px`,
        width: `${spot.value.width}px`,
        height: `${spot.value.height}px`
      }
    : undefined
)
const cardStyle = computed(() => ({
  top: `${position.value.top}px`,
  left: `${position.value.left}px`
}))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="step"
      class="tour"
      :class="{ 'tour--reduced': reducedMotion }"
      data-test="tour"
      :data-tour-kind="tour.kind ?? undefined"
    >
      <!-- Click catcher: the app behind stays inert while the tour is open. -->
      <div class="tour__backdrop" :class="{ 'tour__backdrop--dim': !spot }" aria-hidden="true" />
      <div
        v-if="spot"
        class="tour__spot"
        :style="spotStyle"
        aria-hidden="true"
        data-test="tour-spot"
      />
      <section
        ref="card"
        class="tour__card"
        :class="[`tour__card--${position.placement}`, { 'tour__card--wide': hasActions }]"
        :style="cardStyle"
        role="dialog"
        aria-modal="true"
        :aria-label="ariaLabel"
        aria-labelledby="tour-title"
        aria-describedby="tour-text"
        tabindex="-1"
        :data-test="step.testId ?? 'tour-card'"
      >
        <div class="tour__head">
          <span class="tour__counter nd-mono" aria-live="polite" data-test="tour-counter">{{
            counter
          }}</span>
          <button
            v-if="!hasActions"
            type="button"
            class="tour__skip"
            data-test="tour-skip"
            @click="tour.skip()"
          >
            Saltar tour
          </button>
        </div>
        <h2 id="tour-title" class="tour__title" data-test="tour-title">{{ step.title }}</h2>
        <p id="tour-text" class="tour__text" data-test="tour-text">
          {{ textParts?.before
          }}<code v-if="textParts?.code" class="tour__code">{{ textParts.code }}</code
          >{{ textParts?.after }}
        </p>
        <div class="tour__progress" aria-hidden="true">
          <span
            v-for="(_, i) in tour.steps"
            :key="i"
            class="tour__dot"
            :class="{ 'tour__dot--on': i === tour.index, 'tour__dot--done': i < tour.index }"
          />
        </div>
        <template v-if="hasActions">
          <div class="tour__choices">
            <v-btn
              v-for="a in mainActions"
              :key="a.testId"
              size="small"
              :variant="a.variant === 'primary' ? 'flat' : 'tonal'"
              color="primary"
              :prepend-icon="a.icon"
              :data-test="a.testId"
              :data-tour-primary="a.variant === 'primary' ? '' : undefined"
              @click="tour.runAction(a.run)"
              >{{ a.label }}</v-btn
            >
          </div>
          <div class="tour__actions">
            <v-btn
              variant="text"
              size="small"
              prepend-icon="mdi-arrow-left"
              :disabled="tour.isFirst"
              data-test="tour-prev"
              @click="tour.prev()"
              >Atrás</v-btn
            >
            <v-spacer />
            <v-btn
              v-for="a in dismissActions"
              :key="a.testId"
              variant="text"
              size="small"
              :data-test="a.testId"
              @click="tour.runAction(a.run)"
              >{{ a.label }}</v-btn
            >
          </div>
        </template>
        <div v-else class="tour__actions">
          <v-btn
            variant="text"
            size="small"
            prepend-icon="mdi-arrow-left"
            :disabled="tour.isFirst"
            data-test="tour-prev"
            @click="tour.prev()"
            >Atrás</v-btn
          >
          <v-spacer />
          <v-btn
            color="primary"
            variant="flat"
            size="small"
            :append-icon="tour.isLast ? 'mdi-check' : 'mdi-arrow-right'"
            data-test="tour-next"
            data-tour-primary
            @click="tour.next()"
            >{{ tour.isLast ? 'Terminar' : 'Siguiente' }}</v-btn
          >
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.tour {
  position: fixed;
  inset: 0;
  z-index: 3000;
}
.tour__backdrop {
  position: absolute;
  inset: 0;
  background: transparent;
}
.tour__backdrop--dim {
  background: rgba(4, 6, 14, 0.58);
}
.tour__spot {
  position: absolute;
  border-radius: 10px;
  box-shadow:
    0 0 0 2px rgba(var(--nd-accent-rgb), 0.9),
    0 0 18px 2px rgba(var(--nd-accent-rgb), 0.35),
    0 0 0 9999px rgba(4, 6, 14, 0.58);
  pointer-events: none;
  transition:
    top var(--nd-dur-slow) var(--nd-ease),
    left var(--nd-dur-slow) var(--nd-ease),
    width var(--nd-dur-slow) var(--nd-ease),
    height var(--nd-dur-slow) var(--nd-ease);
}
.tour__card {
  position: absolute;
  width: min(380px, calc(100vw - 24px));
  padding: 14px 16px 10px;
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-border-strong);
  box-shadow: var(--nd-shadow-2);
  color: var(--nd-text);
  outline: none;
  transition:
    top var(--nd-dur-slow) var(--nd-ease),
    left var(--nd-dur-slow) var(--nd-ease);
}
.tour__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.tour__counter {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.tour__skip {
  border: 0;
  background: none;
  padding: 2px 4px;
  border-radius: var(--nd-radius-sm);
  font: inherit;
  font-size: var(--nd-fs-small);
  color: var(--nd-text-2);
  cursor: pointer;
}
.tour__skip:hover {
  color: var(--nd-text);
  background: var(--nd-hover);
}
.tour__skip:focus-visible {
  outline: 2px solid rgba(var(--nd-accent-rgb), 0.8);
  outline-offset: 1px;
}
.tour__title {
  margin: 0 0 4px;
  font-size: var(--nd-fs-heading);
  font-weight: var(--nd-fw-heading);
  line-height: 1.3;
}
.tour__text {
  margin: 0;
  font-size: var(--nd-fs-dense);
  line-height: 1.5;
  color: var(--nd-text-2);
  overflow-wrap: anywhere;
}
.tour__code {
  display: block;
  margin: 6px 0;
  padding: 4px 8px;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  color: var(--nd-text);
  background: var(--nd-bg-sunken);
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-sm);
}
.tour__progress {
  display: flex;
  gap: 4px;
  margin: 12px 0 6px;
}
.tour__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--nd-border-strong);
}
.tour__dot--done {
  background: rgba(var(--nd-accent-rgb), 0.45);
}
.tour__dot--on {
  width: 16px;
  border-radius: 3px;
  background: var(--nd-accent);
}
.tour__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 -6px;
}
.tour__choices {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0 8px;
}
.tour__card--wide {
  width: min(440px, calc(100vw - 24px));
}
.tour--reduced .tour__spot,
.tour--reduced .tour__card {
  transition: none;
}
@media (prefers-reduced-motion: reduce) {
  .tour__spot,
  .tour__card {
    transition: none;
  }
}
</style>
