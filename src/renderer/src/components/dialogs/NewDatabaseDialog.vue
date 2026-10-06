<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api } from '@renderer/api'
import { useConfirm } from '@renderer/composables/useConfirm'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import { useConnectionsStore } from '@renderer/stores/connections'
import { useTreeStore } from '@renderer/stores/tree'
import { useUiStore } from '@renderer/stores/ui'
import DialogHeader from './DialogHeader.vue'

type Charset = { charset: string; defaultCollation: string; collations: string[] }

const ui = useUiStore()
const connections = useConnectionsStore()
const tree = useTreeStore()
const notify = useNotify()
const { confirmDestructive } = useConfirm()

const name = ref('')
const charset = ref('utf8mb4')
const collation = ref('')
const charsets = ref<Charset[]>([])
const loading = ref(false)
const saving = ref(false)
const error = ref('')

const connectionId = computed(() => ui.newDatabaseDialog.connectionId)
const open = computed({
  get: () => ui.newDatabaseDialog.open,
  set: (value: boolean) => {
    ui.newDatabaseDialog = { ...ui.newDatabaseDialog, open: value }
  }
})
const charsetItems = computed(() => charsets.value.map((c) => c.charset).sort())
const collationItems = computed(
  () => charsets.value.find((c) => c.charset === charset.value)?.collations ?? []
)
const nameError = computed(() => {
  const n = name.value.trim()
  if (!n) return ''
  if (n.length > 64) return 'Máximo 64 caracteres'
  if (/[/\\.`]/.test(n)) return 'No uses /, \\, . ni `'
  return ''
})
const canSave = computed(
  () =>
    !!connectionId.value &&
    !!name.value.trim() &&
    !nameError.value &&
    !!charset.value &&
    !saving.value
)

function defaultCollationOf(cs: string): string {
  return charsets.value.find((c) => c.charset === cs)?.defaultCollation ?? ''
}

async function loadCharsets(): Promise<void> {
  if (!connectionId.value) return
  loading.value = true
  try {
    charsets.value = await api.db.charsets(connectionId.value)
    if (!charsets.value.some((c) => c.charset === charset.value))
      charset.value = charsets.value[0]?.charset ?? ''
    collation.value = defaultCollationOf(charset.value)
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    loading.value = false
  }
}

watch(
  () => ui.newDatabaseDialog.open,
  (value) => {
    if (!value) return
    name.value = ''
    charset.value = 'utf8mb4'
    collation.value = ''
    error.value = ''
    void loadCharsets()
  },
  { immediate: true }
)

function onCharsetChange(value: string): void {
  charset.value = value
  collation.value = defaultCollationOf(value)
}

async function save(): Promise<void> {
  if (!canSave.value || !connectionId.value) return
  saving.value = true
  error.value = ''
  const cid = connectionId.value
  const dbName = name.value.trim()
  try {
    // CREATE DATABASE is a write: production connections need explicit confirmation.
    const ok = await confirmDestructive({
      connectionId: cid,
      title: 'Crear base de datos',
      message: `Se creará la base de datos «${dbName}» en «${connections.nameOf(cid)}».`,
      confirmText: 'Crear en producción',
      alwaysAsk: false
    })
    if (!ok) return
    // Silent invoke: the error is shown inline in the dialog, not twice.
    await api.invokeSilent(
      'db:createDatabase',
      cid,
      dbName,
      charset.value,
      collation.value || defaultCollationOf(charset.value),
      { confirmProduction: true }
    )
    notify.success(`Base de datos ${dbName} creada`)
    open.value = false
    await tree.loadDatabases(cid, true).catch(() => undefined)
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="480">
    <v-card data-test="new-database-dialog">
      <DialogHeader
        icon="mdi-database-plus"
        title="Nueva base de datos"
        :subtitle="connectionId ? connections.nameOf(connectionId) : undefined"
      />
      <v-card-text class="d-flex flex-column ga-3 newdb-dialog__body">
        <v-text-field
          v-model="name"
          label="Nombre"
          autofocus
          class="newdb-dialog__name"
          :error-messages="nameError ? [nameError] : []"
          data-test="newdb-name"
          @keyup.enter="save"
        />
        <v-autocomplete
          :model-value="charset"
          :items="charsetItems"
          :loading="loading"
          label="Juego de caracteres"
          @update:model-value="onCharsetChange"
        />
        <v-autocomplete
          v-model="collation"
          :items="collationItems"
          :loading="loading"
          label="Intercalación"
        />
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
          data-test="newdb-save"
          @click="save"
          >Crear</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.newdb-dialog__body {
  padding-top: 4px !important;
}
.newdb-dialog__name :deep(input) {
  font-family: var(--nd-font-mono);
}
</style>
