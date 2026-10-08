<script setup lang="ts">
import { ref } from 'vue'
import type { BackupMeta } from '@shared/types'
import { errorMessage } from '@renderer/composables/useNotify'
import { useBackupsStore } from '@renderer/stores/backups'

/**
 * Asks for the password of an encrypted .vqb and opens it (main checks it
 * before reading anything). The password is remembered for this session by
 * the backups store, never saved.
 */
const props = withDefaults(
  defineProps<{
    path: string
    /** One line above the field. */
    message?: string
    disabled?: boolean
  }>(),
  {
    message: 'Copia cifrada: escribe su contraseña para ver su contenido y restaurarla.',
    disabled: false
  }
)
const emit = defineEmits<{ unlocked: [meta: BackupMeta] }>()

const backups = useBackupsStore()
const password = ref('')
const visible = ref(false)
const busy = ref(false)
const error = ref('')

async function submit(): Promise<void> {
  if (!password.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const meta = await backups.unlock(props.path, password.value)
    password.value = ''
    emit('unlocked', meta)
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="backup-password" data-test="backup-password">
    <div class="backup-password__message">
      <v-icon icon="mdi-lock-outline" size="16" aria-hidden="true" />
      <span>{{ message }}</span>
    </div>
    <form class="backup-password__row" @submit.prevent="submit">
      <v-text-field
        v-model="password"
        :type="visible ? 'text' : 'password'"
        label="Contraseña de la copia"
        density="compact"
        autocomplete="off"
        :disabled="disabled || busy"
        :error-messages="error ? [error] : []"
        :append-inner-icon="visible ? 'mdi-eye-off-outline' : 'mdi-eye-outline'"
        data-test="backup-password-input"
        @click:append-inner="visible = !visible"
      />
      <v-btn
        type="submit"
        color="primary"
        variant="tonal"
        prepend-icon="mdi-lock-open-variant-outline"
        :loading="busy"
        :disabled="disabled || !password"
        data-test="backup-password-submit"
        >Abrir</v-btn
      >
    </form>
  </div>
</template>

<style scoped>
.backup-password {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-control);
  background: rgba(var(--v-theme-warning), 0.06);
}
.backup-password__message {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.backup-password__row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.backup-password__row :deep(.v-input) {
  flex: 1;
}
.backup-password__row .v-btn {
  margin-top: 2px;
}
</style>
