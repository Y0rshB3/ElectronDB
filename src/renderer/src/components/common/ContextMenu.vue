<script setup lang="ts">
import { ref } from 'vue'
import type { MenuAction } from '@renderer/composables/useObjectActions'
import { runSafely } from '@renderer/utils/errors'

const open = ref(false)
const position = ref<[number, number]>([0, 0])
const actions = ref<MenuAction[]>([])

function show(event: MouseEvent, items: MenuAction[]): void {
  actions.value = items
  position.value = [event.clientX, event.clientY]
  open.value = true
}

function run(item: MenuAction): void {
  open.value = false
  void runSafely(item.action)
}

defineExpose({ show })
</script>

<template>
  <v-menu v-model="open" :target="position" location="bottom start" :close-on-content-click="true">
    <v-list density="compact" min-width="220" class="context-menu" data-test="context-menu">
      <template v-for="item in actions" :key="item.key">
        <v-divider v-if="item.divider" class="context-menu__divider" />
        <v-list-item
          v-else
          :prepend-icon="item.icon"
          :title="item.label"
          :disabled="item.disabled"
          :class="{ 'context-menu__item--danger': item.danger }"
          :data-test="`menu-${item.key}`"
          @click="run(item)"
        />
      </template>
    </v-list>
  </v-menu>
</template>

<style scoped>
.context-menu__divider {
  margin: 4px 6px;
}
.context-menu :deep(.v-list-item) {
  min-height: 30px;
}
/* Destructive items stay neutral until hovered, then turn red. */
.context-menu__item--danger:hover,
.context-menu__item--danger:focus-visible {
  color: var(--nd-error);
  background: var(--nd-error-soft);
}
.context-menu__item--danger:hover :deep(.v-list-item__prepend > .v-icon),
.context-menu__item--danger:focus-visible :deep(.v-list-item__prepend > .v-icon) {
  color: var(--nd-error);
}
.context-menu__item--danger:hover :deep(.v-list-item__overlay) {
  opacity: 0;
}
</style>
