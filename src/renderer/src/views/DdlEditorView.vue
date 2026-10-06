<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '@renderer/api'
import EmptyState from '@renderer/components/common/EmptyState.vue'
import SqlEditor from '@renderer/components/common/SqlEditor.vue'
import { firstError, friendlyError } from '@renderer/components/data/privileges'
import {
  buildDdlScript,
  ddlTemplate,
  isRename,
  parseObjectName,
  type DdlObjectType
} from '@renderer/components/designer/ddl'
import { useConfirm } from '@renderer/composables/useConfirm'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'
import { tabTitle, useTabsStore, type WorkspaceTab } from '@renderer/stores/tabs'
import { useTreeStore } from '@renderer/stores/tree'
import { OBJECT_TYPE_LABELS } from '@renderer/utils/objectTypes'
import type { GroupKind } from '@renderer/utils/objectTypes'

const props = defineProps<{ tab: WorkspaceTab }>()

const tabs = useTabsStore()
const tree = useTreeStore()
const connections = useConnectionsStore()
const notify = useNotify()
const { confirmDestructive } = useConfirm()

const objectType = computed<DdlObjectType>(() =>
  props.tab.objectType && props.tab.objectType !== 'table' ? props.tab.objectType : 'view'
)
const objectName = ref<string | null>(props.tab.objectName || null)
const sql = ref('')
const loadedSql = ref('')
const removeDefiner = ref(false)
const loading = ref(false)
const applying = ref(false)
const loadError = ref<string | null>(null)
const showScript = ref(false)

const connectionId = computed(() => props.tab.connectionId ?? '')
const schema = computed(() => props.tab.schema ?? '')
const typeLabel = computed(() => OBJECT_TYPE_LABELS[objectType.value])
const dirty = computed(() => sql.value !== loadedSql.value)
const script = computed(() =>
  sql.value.trim()
    ? buildDdlScript(sql.value, {
        type: objectType.value,
        schema: schema.value,
        originalName: objectName.value,
        removeDefiner: removeDefiner.value
      })
    : ''
)
const hasDefiner = computed(() => /\bDEFINER\s*=/i.test(sql.value))

watch(dirty, (value) => tabs.setDirty(props.tab.id, value), { immediate: true })

const GROUP: Record<DdlObjectType, GroupKind | null> = {
  view: 'views',
  function: 'functions',
  procedure: 'functions',
  event: 'events',
  // The connection tree has no trigger group (triggers are not listed there), so there is nothing to refresh.
  trigger: null
}

async function load(): Promise<void> {
  if (!connectionId.value || !schema.value) {
    loadError.value = 'La pestaña no tiene conexión o esquema asociados'
    return
  }
  loadError.value = null
  if (!objectName.value) {
    sql.value = ddlTemplate(objectType.value)
    loadedSql.value = ''
    return
  }
  loading.value = true
  try {
    const ddl = await api.invokeSilent(
      'db:showCreate',
      connectionId.value,
      schema.value,
      objectType.value,
      objectName.value
    )
    sql.value = ddl
    loadedSql.value = ddl
  } catch (err) {
    loadError.value = errorMessage(err)
  } finally {
    loading.value = false
  }
}

async function apply(): Promise<void> {
  if (applying.value || !script.value) return
  const rename = isRename(sql.value, objectType.value, objectName.value)
  const newName = parseObjectName(sql.value, objectType.value)
  const replaces = !!objectName.value && (objectType.value !== 'view' || rename)
  const message = rename
    ? `El nombre cambia: se creará ${typeLabel.value} "${newName}" y se eliminará "${objectName.value}". Lo que dependa del nombre anterior dejará de funcionar.`
    : replaces
      ? `Se eliminará y volverá a crear ${typeLabel.value} "${objectName.value}". Si la creación falla, el objeto quedará eliminado; el SQL sigue en el editor para reintentar.`
      : 'Se ejecutará el siguiente SQL.'
  const ok = await confirmDestructive({
    connectionId: connectionId.value,
    title: objectName.value ? `Aplicar cambios en ${typeLabel.value}` : `Crear ${typeLabel.value}`,
    message,
    details: script.value,
    alwaysAsk: replaces
  })
  if (!ok) return

  applying.value = true
  try {
    const results = await api.invokeSilent('db:execute', connectionId.value, script.value, {
      schema: schema.value,
      confirmProduction: true
    })
    const error = firstError(results)
    if (error) {
      notify.error(friendlyError(error))
      return
    }
    const name = parseObjectName(sql.value, objectType.value) ?? objectName.value
    const wasNew = !objectName.value
    const renamed = name !== objectName.value
    objectName.value = name
    if (wasNew || renamed) {
      if (name)
        tabs.setTitle(
          props.tab.id,
          tabTitle(name, schema.value, connections.nameOf(connectionId.value))
        )
      const group = GROUP[objectType.value]
      if (group)
        void tree.loadGroup(connectionId.value, schema.value, group, true).catch(() => undefined)
    }
    notify.success(
      `${typeLabel.value.charAt(0).toUpperCase()}${typeLabel.value.slice(1)} "${name ?? ''}" guardado`
    )
    if (name) await load()
    else loadedSql.value = sql.value
  } catch (err) {
    notify.error(friendlyError(errorMessage(err)))
  } finally {
    applying.value = false
  }
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    void apply()
  }
}

onMounted(load)

defineExpose({ sql, script, apply })
</script>

<template>
  <div class="nd-view ddl-editor" @keydown="onKeydown">
    <div class="nd-viewbar" role="toolbar" aria-label="Acciones del editor DDL">
      <v-btn
        prepend-icon="mdi-check"
        size="small"
        color="primary"
        variant="flat"
        :disabled="!script || loading"
        :loading="applying"
        title="Aplicar (Cmd+S)"
        data-test="apply"
        @click="apply"
      >
        Aplicar
      </v-btn>
      <v-btn
        prepend-icon="mdi-refresh"
        size="small"
        class="ml-1"
        :disabled="applying || !objectName"
        :loading="loading"
        @click="load"
        >Recargar</v-btn
      >
      <span class="nd-viewbar__sep" aria-hidden="true" />
      <v-btn
        :prepend-icon="showScript ? 'mdi-eye-off-outline' : 'mdi-eye-outline'"
        size="small"
        :disabled="!script"
        :class="{ 'is-on': showScript }"
        :aria-pressed="showScript"
        @click="showScript = !showScript"
      >
        {{ showScript ? 'Ocultar SQL a ejecutar' : 'Ver SQL a ejecutar' }}
      </v-btn>
      <v-checkbox
        v-model="removeDefiner"
        label="Quitar DEFINER"
        density="compact"
        hide-details
        :disabled="!hasDefiner"
        class="ddl-editor__definer ml-2"
        title="Elimina la cláusula DEFINER para crear el objeto con el usuario actual"
        data-test="remove-definer"
      />
      <span class="nd-viewbar__spacer" />
      <span class="nd-status-pill" :class="{ 'nd-status-pill--accent': !objectName }">
        <v-icon icon="mdi-code-braces" size="13" />
        {{ objectName ? typeLabel : `Nuevo ${typeLabel}` }}
      </span>
    </div>

    <EmptyState
      v-if="loadError"
      icon="mdi-alert-circle-outline"
      :title="`No se pudo cargar ${typeLabel}`"
      :description="loadError"
    >
      <v-btn variant="tonal" size="small" prepend-icon="mdi-refresh" @click="load"
        >Reintentar</v-btn
      >
    </EmptyState>
    <div v-else class="ddl-editor__body">
      <div class="nd-viewpanel ddl-editor__editor">
        <v-progress-linear
          v-if="loading"
          indeterminate
          color="primary"
          height="2"
          class="nd-viewpanel__loader"
        />
        <SqlEditor v-model="sql" @run="apply" @save="apply" />
      </div>
      <div v-if="showScript" class="nd-viewpanel ddl-editor__script">
        <div class="ddl-editor__script-head">
          <v-icon icon="mdi-play-circle-outline" size="14" />
          SQL que se ejecutará
        </div>
        <pre class="ddl-editor__pre" data-test="script-preview">{{ script }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped src="../components/data/viewChrome.css"></style>
<style scoped>
.ddl-editor__definer {
  flex: 0 0 auto;
}
.ddl-editor__definer :deep(.v-label) {
  font-size: var(--nd-fs-dense);
}
.is-on {
  color: var(--nd-accent);
}
.ddl-editor__body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
.ddl-editor__editor {
  background: var(--nd-bg-sunken);
}
.ddl-editor__editor:focus-within {
  border-color: rgba(var(--nd-accent-rgb), 0.45);
  box-shadow: var(--nd-glow);
}
.ddl-editor__script {
  flex: 0 0 35%;
}
.ddl-editor__script-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding: 8px 12px;
  font-size: var(--nd-fs-small);
  font-weight: 600;
  color: var(--nd-text-2);
  border-bottom: 1px solid var(--nd-hairline);
  background: var(--nd-bg-raised);
}
.ddl-editor__script-head .v-icon {
  color: var(--nd-accent);
}
.ddl-editor__pre {
  flex: 1 1 auto;
  overflow: auto;
  margin: 0;
  padding: 10px 14px 14px;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
  line-height: 1.6;
  color: var(--nd-text);
  white-space: pre-wrap;
}
</style>
