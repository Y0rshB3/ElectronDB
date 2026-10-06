<script setup lang="ts">
import {
  computed,
  defineComponent,
  h,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type Component,
  type PropType
} from 'vue'
import { useTabsStore, type WorkspaceTab } from '@renderer/stores/tabs'
import { useTabActions } from '@renderer/composables/useTabActions'
import type { MenuAction } from '@renderer/composables/useObjectActions'
import { viewFor } from '@renderer/views/registry'
import ContextMenu from '@renderer/components/common/ContextMenu.vue'

const tabs = useTabsStore()
const { requestClose, closeOthers } = useTabActions()
const menu = ref<InstanceType<typeof ContextMenu> | null>(null)

/*
 * Views are cached by <KeepAlive> per tab. Each tab gets its own named wrapper
 * component so that removing the name from `include` when a tab closes prunes
 * its cached instance: reopening a tab with the same id never resurrects state
 * the user discarded, and closed tabs do not leak memory.
 */
const wrappers = new Map<string, Component>()
/*
 * Component names must not derive from the tab id: KeepAlive splits string
 * `include` patterns on ',' and ids embed object names (a table may be called
 * `a,b`). A per-id sequence number yields safe, unique names.
 */
const wrapperNames = new Map<string, string>()
let wrapperSeq = 0

function wrapperFor(tab: WorkspaceTab): Component {
  let wrapper = wrappers.get(tab.id)
  if (!wrapper) {
    wrapper = defineComponent({
      name: wrapperName(tab.id),
      props: { tab: { type: Object as PropType<WorkspaceTab>, required: true } },
      setup: (props) => () => h(viewFor(props.tab.kind), { tab: props.tab })
    })
    wrappers.set(tab.id, wrapper)
  }
  return wrapper
}

function wrapperName(id: string): string {
  let name = wrapperNames.get(id)
  if (!name) {
    name = `WorkspaceTab${++wrapperSeq}`
    wrapperNames.set(id, name)
  }
  return name
}

const cachedNames = computed(() => tabs.tabs.map((t) => wrapperName(t.id)))

watch(
  () => tabs.tabs.map((t) => t.id),
  (ids) => {
    for (const id of wrappers.keys()) if (!ids.includes(id)) wrappers.delete(id)
    for (const id of wrapperNames.keys()) if (!ids.includes(id)) wrapperNames.delete(id)
  }
)

/*
 * Overflow affordance: when the pills do not fit, the rail fades at the clipped
 * edge(s) and shows ghost chevrons so the user knows more tabs exist.
 */
const strip = ref<HTMLElement | null>(null)
const canScrollLeft = ref(false)
const canScrollRight = ref(false)
let resizeObserver: ResizeObserver | null = null

function updateOverflow(): void {
  const el = strip.value
  if (!el) return
  canScrollLeft.value = el.scrollLeft > 1
  canScrollRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
}

function scrollRail(direction: -1 | 1): void {
  const el = strip.value
  if (!el) return
  el.scrollBy?.({ left: direction * Math.max(160, el.clientWidth * 0.6), behavior: 'smooth' })
}

onMounted(() => {
  updateOverflow()
  if (typeof ResizeObserver !== 'undefined' && strip.value) {
    resizeObserver = new ResizeObserver(updateOverflow)
    resizeObserver.observe(strip.value)
  }
})
onBeforeUnmount(() => resizeObserver?.disconnect())

watch(
  () => tabs.tabs.map((t) => `${t.id}:${t.title}`).join('|'),
  async () => {
    await nextTick()
    updateOverflow()
  }
)

/* Keep the active pill visible when the rail overflows (new tabs open at the end). */
watch(
  () => tabs.activeId,
  async (id) => {
    await nextTick()
    document.getElementById(`tab-${id}`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    updateOverflow()
  }
)

function onAuxClick(event: MouseEvent, tab: WorkspaceTab): void {
  if (event.button === 1 && tab.closable) {
    event.preventDefault()
    void requestClose(tab.id)
  }
}

function onContextMenu(event: MouseEvent, tab: WorkspaceTab): void {
  const items: MenuAction[] = [
    {
      key: 'close',
      label: 'Cerrar',
      icon: 'mdi-close',
      disabled: !tab.closable,
      action: () => void requestClose(tab.id)
    },
    {
      key: 'closeOthers',
      label: 'Cerrar las demás',
      icon: 'mdi-close-box-multiple-outline',
      action: () => closeOthers(tab.id)
    }
  ]
  menu.value?.show(event, items)
}

function onKeydown(event: KeyboardEvent, index: number): void {
  const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  if (!delta) return
  event.preventDefault()
  const next = tabs.tabs[(index + delta + tabs.tabs.length) % tabs.tabs.length]
  tabs.activate(next.id)
  ;(document.getElementById(`tab-${next.id}`) as HTMLElement | null)?.focus()
}
</script>

<template>
  <section class="workspace-tabs">
    <div
      class="workspace-tabs__rail"
      :class="{
        'workspace-tabs__rail--fade-left': canScrollLeft,
        'workspace-tabs__rail--fade-right': canScrollRight
      }"
    >
      <button
        v-if="canScrollLeft || canScrollRight"
        type="button"
        class="workspace-tabs__scroll"
        :disabled="!canScrollLeft"
        aria-label="Desplazar pestañas a la izquierda"
        title="Pestañas anteriores"
        tabindex="-1"
        @click="scrollRail(-1)"
      >
        <v-icon icon="mdi-chevron-left" size="16" />
      </button>
      <div
        ref="strip"
        class="workspace-tabs__strip"
        role="tablist"
        aria-label="Pestañas abiertas"
        @scroll.passive="updateOverflow"
      >
        <div
          v-for="(entry, index) in tabs.tabs"
          :id="`tab-${entry.id}`"
          :key="entry.id"
          class="workspace-tabs__tab"
          :class="{
            'workspace-tabs__tab--active': entry.id === tabs.activeId,
            'workspace-tabs__tab--fixed': !entry.closable
          }"
          role="tab"
          :aria-selected="entry.id === tabs.activeId"
          :aria-controls="`tabpanel-${entry.id}`"
          :tabindex="entry.id === tabs.activeId ? 0 : -1"
          :title="entry.title"
          :data-test="`tab-${entry.kind}`"
          :data-tab-id="entry.id"
          @click="tabs.activate(entry.id)"
          @mousedown.middle.prevent
          @auxclick="onAuxClick($event, entry)"
          @contextmenu.prevent="onContextMenu($event, entry)"
          @keydown="onKeydown($event, index)"
        >
          <v-icon :icon="entry.icon" size="15" class="workspace-tabs__icon" />
          <span class="workspace-tabs__title">{{ entry.title }}</span>
          <span
            v-if="entry.dirty"
            class="workspace-tabs__dirty"
            aria-label="Cambios sin guardar"
            data-test="tab-dirty"
          />
          <button
            v-if="entry.closable"
            type="button"
            class="workspace-tabs__close"
            :aria-label="`Cerrar ${entry.title}`"
            tabindex="-1"
            data-test="tab-close"
            @click.stop="requestClose(entry.id)"
          >
            <v-icon icon="mdi-close" size="12" />
          </button>
        </div>
      </div>
      <button
        v-if="canScrollLeft || canScrollRight"
        type="button"
        class="workspace-tabs__scroll"
        :disabled="!canScrollRight"
        aria-label="Desplazar pestañas a la derecha"
        title="Pestañas siguientes"
        tabindex="-1"
        @click="scrollRail(1)"
      >
        <v-icon icon="mdi-chevron-right" size="16" />
      </button>
    </div>
    <div
      :id="`tabpanel-${tabs.active.id}`"
      class="workspace-tabs__panel"
      role="tabpanel"
      :aria-labelledby="`tab-${tabs.active.id}`"
      :data-test="`panel-${tabs.active.kind}`"
    >
      <KeepAlive :include="cachedNames">
        <component :is="wrapperFor(tabs.active)" :key="tabs.active.id" :tab="tabs.active" />
      </KeepAlive>
    </div>
    <ContextMenu ref="menu" />
  </section>
</template>

<style scoped>
.workspace-tabs {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: transparent;
}
/* Dark rail holding pill-shaped tabs (plus overflow chevrons). */
.workspace-tabs__rail {
  display: flex;
  align-items: center;
  flex: none;
  height: 42px;
  min-width: 0;
  padding: 0 4px;
  gap: 2px;
  background: var(--nd-bg-sunken);
  border-bottom: 1px solid var(--nd-border);
  --nd-tabs-fade-l: 0px;
  --nd-tabs-fade-r: 0px;
}
.workspace-tabs__rail--fade-left {
  --nd-tabs-fade-l: 28px;
}
.workspace-tabs__rail--fade-right {
  --nd-tabs-fade-r: 28px;
}
.workspace-tabs__strip {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0 2px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  scroll-behavior: smooth;
  /* Edge fade only on the side(s) that are actually clipped. */
  -webkit-mask-image: linear-gradient(
    to right,
    transparent 0,
    #000 var(--nd-tabs-fade-l),
    #000 calc(100% - var(--nd-tabs-fade-r)),
    transparent 100%
  );
  mask-image: linear-gradient(
    to right,
    transparent 0,
    #000 var(--nd-tabs-fade-l),
    #000 calc(100% - var(--nd-tabs-fade-r)),
    transparent 100%
  );
}
.workspace-tabs__scroll {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 24px;
  height: 26px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--nd-radius-control);
  background: none;
  color: var(--nd-text-2);
  transition:
    background-color var(--nd-dur) var(--nd-ease),
    color var(--nd-dur) var(--nd-ease),
    opacity var(--nd-dur) var(--nd-ease);
}
.workspace-tabs__scroll:not(:disabled):hover {
  background: var(--nd-hover);
  color: var(--nd-text);
  border-color: var(--nd-border);
}
.workspace-tabs__scroll:disabled {
  opacity: 0.35;
}
@media (prefers-reduced-motion: reduce) {
  .workspace-tabs__strip {
    scroll-behavior: auto;
  }
}
.workspace-tabs__strip::-webkit-scrollbar {
  display: none;
}
.workspace-tabs__tab {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: none;
  height: 30px;
  min-width: 96px;
  max-width: 260px;
  padding: 0 6px 0 11px;
  font-size: var(--nd-fs-dense);
  font-weight: 500;
  cursor: default;
  user-select: none;
  border-radius: var(--nd-radius-control);
  border: 1px solid transparent;
  color: var(--nd-text-2);
  position: relative;
  outline: none;
  transition:
    background-color var(--nd-dur) var(--nd-ease),
    border-color var(--nd-dur) var(--nd-ease),
    color var(--nd-dur) var(--nd-ease),
    box-shadow var(--nd-dur) var(--nd-ease);
}
.workspace-tabs__tab:hover {
  background: var(--nd-hover);
  color: var(--nd-text);
}
.workspace-tabs__tab:focus-visible {
  box-shadow: var(--nd-glow);
}
/* Active tab: raised glass pill with a glowing gradient underline. */
.workspace-tabs__tab--active,
.workspace-tabs__tab--active:hover {
  background: var(--nd-bg-raised);
  border-color: var(--nd-border-strong);
  color: var(--nd-text);
  box-shadow: var(--nd-shadow-1), var(--nd-shadow-inset);
}
.workspace-tabs__tab--active::after {
  content: '';
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--nd-accent-gradient-h);
  box-shadow: 0 0 10px rgba(var(--nd-accent-rgb), 0.55);
}
.workspace-tabs__tab--fixed {
  min-width: 0;
  padding-right: 12px;
}
.workspace-tabs__icon {
  flex: none;
  color: var(--nd-text-muted);
  transition: color var(--nd-dur) var(--nd-ease);
}
.workspace-tabs__tab--active .workspace-tabs__icon {
  color: var(--nd-accent);
}
.workspace-tabs__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workspace-tabs__dirty {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--nd-warning);
  box-shadow: 0 0 6px color-mix(in srgb, var(--nd-warning) 70%, transparent);
  flex: none;
}
.workspace-tabs__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 5px;
  background: none;
  color: inherit;
  padding: 0;
  flex: none;
  opacity: 0;
  transition:
    opacity var(--nd-dur-fast) var(--nd-ease),
    background-color var(--nd-dur-fast) var(--nd-ease);
}
.workspace-tabs__tab:hover .workspace-tabs__close,
.workspace-tabs__tab--active .workspace-tabs__close {
  opacity: 0.65;
}
.workspace-tabs__close:hover {
  opacity: 1 !important;
  background: var(--nd-pressed);
}
.workspace-tabs__panel {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
