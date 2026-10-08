<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api } from '@renderer/api'
import { typedTarget, useConfirm } from '@renderer/composables/useConfirm'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useTreeStore } from '@renderer/stores/tree'
import { useUiStore } from '@renderer/stores/ui'
import DialogHeader from '@renderer/components/dialogs/DialogHeader.vue'

/**
 * «Duplicar colección» (MongoDB): a new collection with the options and
 * indexes of the original and, optionally, its documents with their BSON
 * types. A view is duplicated as a view with the same pipeline.
 */
const ui = useUiStore()
const connections = useConnectionsStore()
const tree = useTreeStore()
const notify = useNotify()
const { confirmDestructive } = useConfirm()

const name = ref('')
const includeDocuments = ref(true)
const saving = ref(false)
const error = ref('')

const request = computed(() => ui.duplicateCollectionDialog)
const open = computed({
  get: () => request.value.open,
  set: (value: boolean) => {
    ui.duplicateCollectionDialog = { ...ui.duplicateCollectionDialog, open: value }
  }
})
const nameError = computed(() => {
  const n = name.value.trim()
  if (!n) return ''
  if (n.includes('$')) return 'No uses $'
  if (n.startsWith('system.')) return 'No puede empezar por «system.»'
  if (n === request.value.collection) return 'Elige un nombre distinto del original'
  return ''
})
const canSave = computed(() => !!name.value.trim() && !nameError.value && !saving.value)

watch(
  () => request.value.open,
  (value) => {
    if (!value) return
    name.value = `${request.value.collection}_copia`
    includeDocuments.value = true
    error.value = ''
  },
  { immediate: true }
)

async function save(): Promise<void> {
  const { connectionId, database, collection, view } = request.value
  if (!canSave.value || !connectionId || !database || !collection) return
  const target = name.value.trim()
  saving.value = true
  error.value = ''
  try {
    // Creating a collection is a write: guarded connections need the typed name.
    const ok = await confirmDestructive({
      connectionId,
      title: view ? 'Duplicar vista' : 'Duplicar colección',
      message: `Se creará «${target}» en ${database} como copia de «${collection}».`,
      confirmText: `Duplicar en ${typedTarget(connections.get(connectionId))}`,
      alwaysAsk: false
    })
    if (!ok) return
    const copy = !view && includeDocuments.value
    const result = await api.invokeSilent(
      'mongo:duplicateCollection',
      connectionId,
      database,
      collection,
      target,
      copy,
      { confirmProduction: true }
    )
    const parts = view
      ? ['vista con el mismo pipeline']
      : [
          `${result.indexes} ${result.indexes === 1 ? 'índice' : 'índices'}`,
          ...(copy
            ? [`${result.documents.toLocaleString('es-ES')} documento(s)`]
            : ['sin documentos'])
        ]
    notify.success(`«${target}» creada: ${parts.join(', ')}`)
    for (const w of result.warnings) notify.warning(w)
    open.value = false
    await tree
      .loadGroup(connectionId, database, view ? 'views' : 'collections', true)
      .catch(() => undefined)
    if (!view && tree.hasItems(connectionId, database, 'indexes'))
      await tree.loadGroup(connectionId, database, 'indexes', true).catch(() => undefined)
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="480">
    <v-card data-test="duplicate-collection-dialog">
      <DialogHeader
        icon="mdi-content-duplicate"
        :title="request.view ? 'Duplicar vista' : 'Duplicar colección'"
        :subtitle="
          request.connectionId
            ? `${connections.nameOf(request.connectionId)} · ${request.database}.${request.collection}`
            : undefined
        "
      />
      <v-card-text class="d-flex flex-column ga-3 duplicate-dialog__body">
        <v-text-field
          v-model="name"
          label="Nombre de la copia"
          autofocus
          class="duplicate-dialog__name"
          :error-messages="nameError ? [nameError] : []"
          data-test="duplicate-name"
          @keyup.enter="save"
        />
        <template v-if="!request.view">
          <v-checkbox
            v-model="includeDocuments"
            label="Copiar también los documentos"
            density="compact"
            hide-details
            data-test="duplicate-documents"
          />
          <p class="duplicate-dialog__hint">
            Se copian las opciones (validador, colección limitada, intercalación, series temporales)
            y los índices; los documentos conservan sus tipos BSON.
          </p>
        </template>
        <p v-else class="duplicate-dialog__hint">
          La vista nueva usa el mismo pipeline sobre la misma colección.
        </p>
        <v-alert v-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">Cancelar</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :disabled="!canSave"
          :loading="saving"
          data-test="duplicate-save"
          @click="save"
          >Duplicar</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.duplicate-dialog__body {
  padding-top: 4px !important;
}
.duplicate-dialog__name :deep(input) {
  font-family: var(--nd-font-mono);
}
.duplicate-dialog__hint {
  margin: 0;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
</style>
