<script setup lang="ts">
import { computed, ref } from 'vue'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useTreeStore, nodeIds, type TreeNode } from '@renderer/stores/tree'
import { useUiStore } from '@renderer/stores/ui'
import { useWorkspace } from '@renderer/composables/useWorkspace'
import { useObjectActions } from '@renderer/composables/useObjectActions'
import TreeNodeRow from './TreeNodeRow.vue'
import ContextMenu from '@renderer/components/common/ContextMenu.vue'
import EmptyState from '@renderer/components/common/EmptyState.vue'

const tree = useTreeStore()
const connections = useConnectionsStore()
const ui = useUiStore()
const ws = useWorkspace()
const { actionsFor } = useObjectActions()

const menu = ref<InstanceType<typeof ContextMenu> | null>(null)

const roots = computed<TreeNode[]>(() =>
  connections.sorted
    .map((c) => tree.parse(nodeIds.connection(c.id))!)
    .filter((n) => !tree.filter || tree.matchesFilter(n) || tree.isExpanded(n.id))
)

/** Selecting a container node (connection, schema, group) shows its contents in the Objects tab. */
function onSelect(node: TreeNode): void {
  tree.select(node.id)
  if (node.kind !== 'object') ws.showObjects()
}

function onContextMenu(event: MouseEvent, node: TreeNode): void {
  tree.select(node.id)
  menu.value?.show(event, actionsFor(node))
}
</script>

<template>
  <aside class="connection-tree" aria-label="Mis Conexiones" data-tour="connection-tree">
    <div class="connection-tree__header">
      <span class="connection-tree__title">Mis Conexiones</span>
      <span
        v-if="connections.items.length"
        class="connection-tree__count nd-mono"
        :title="`${connections.openIds.length} abiertas de ${connections.items.length}`"
        >{{ connections.openIds.length }}/{{ connections.items.length }}</span
      >
      <v-spacer />
      <v-btn
        icon="mdi-plus"
        size="x-small"
        variant="text"
        class="connection-tree__add"
        aria-label="Nueva conexión"
        title="Nueva conexión"
        @click="ui.openConnectionDialog(null)"
      />
    </div>
    <div class="connection-tree__search">
      <v-text-field
        v-model="tree.filter"
        density="compact"
        variant="outlined"
        placeholder="Buscar"
        prepend-inner-icon="mdi-magnify"
        clearable
        hide-details
        aria-label="Buscar en el árbol"
      />
    </div>
    <div class="connection-tree__body" role="tree">
      <EmptyState
        v-if="connections.loaded && connections.items.length === 0"
        icon="mdi-database-off-outline"
        title="Sin conexiones"
        description="Importa tus conexiones de Navicat o crea una nueva conexión MySQL."
      >
        <v-btn
          color="primary"
          variant="tonal"
          size="small"
          prepend-icon="mdi-import"
          data-test="import-cta"
          @click="ui.openImportDialog()"
          >Importar de Navicat</v-btn
        >
        <v-btn variant="text" size="small" @click="ui.openConnectionDialog(null)"
          >Nueva conexión</v-btn
        >
      </EmptyState>
      <TreeNodeRow
        v-for="node in roots"
        :key="node.id"
        :node="node"
        :depth="0"
        @toggle="tree.toggle"
        @select="onSelect"
        @open="ws.openNode"
        @contextmenu="onContextMenu"
      />
    </div>
    <ContextMenu ref="menu" />
  </aside>
</template>

<style scoped>
.connection-tree {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: transparent;
}
.connection-tree__header {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 6px 0 14px;
  flex: none;
}
.connection-tree__title {
  font-size: var(--nd-fs-dense);
  font-weight: 600;
  color: var(--nd-text);
  white-space: nowrap;
}
.connection-tree__count {
  font-size: 10.5px;
  color: var(--nd-text-muted);
  padding: 1px 6px;
  border-radius: var(--nd-radius-pill);
  background: var(--nd-hover);
  border: 1px solid var(--nd-hairline);
}
.connection-tree__add.v-btn {
  color: var(--nd-text-2);
}
.connection-tree__add.v-btn:hover {
  color: var(--nd-accent);
}
.connection-tree__search {
  padding: 0 10px 8px;
  flex: none;
}
.connection-tree__search :deep(.v-field) {
  font-size: var(--nd-fs-dense);
}
.connection-tree__search :deep(.v-field__input) {
  min-height: 30px;
  padding-top: 4px;
  padding-bottom: 4px;
}
.connection-tree__body {
  flex: 1;
  overflow: auto;
  padding: 2px 0 8px;
  border-top: 1px solid var(--nd-hairline);
}
</style>
