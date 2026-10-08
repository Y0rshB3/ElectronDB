<script setup lang="ts">
/**
 * Query tabs: SQL engines use QueryView, MongoDB its own shell-syntax view
 * (docs/multi-engine-design.md, 9.3). The tab keeps one kind ('query'), so
 * saved queries, the close prompt and shortcuts work the same for both.
 */
import { computed, defineAsyncComponent } from 'vue'
import type { WorkspaceTab } from '@renderer/stores/tabs'
import { useConnectionsStore } from '@renderer/stores/connections'

const props = defineProps<{ tab: WorkspaceTab }>()
const connections = useConnectionsStore()

const QueryView = defineAsyncComponent(() => import('./QueryView.vue'))
const MongoQueryView = defineAsyncComponent(() => import('./MongoQueryView.vue'))

const isMongo = computed(
  () => !!props.tab.connectionId && connections.get(props.tab.connectionId)?.engine === 'mongodb'
)
</script>

<template>
  <MongoQueryView v-if="isMongo" :key="`mongo-${tab.id}`" :tab="tab" />
  <QueryView v-else :key="`sql-${tab.id}`" :tab="tab" />
</template>
