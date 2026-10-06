<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  AUTH_PLUGINS,
  userActionSql,
  validateUserForm,
  type UserAction,
  type UserActionForm
} from './userSql'

const props = defineProps<{
  action: UserAction
  initial: Partial<UserActionForm>
  schemas: string[]
  busy?: boolean
}>()

const emit = defineEmits<{ apply: [form: UserActionForm] }>()
const open = defineModel<boolean>({ default: false })

const TITLES: Record<UserAction, string> = {
  create: 'Nuevo usuario',
  password: 'Cambiar contraseña',
  lock: 'Bloquear cuenta',
  unlock: 'Desbloquear cuenta',
  grant: 'Otorgar todos los privilegios',
  drop: 'Eliminar usuario'
}

const ICONS: Record<UserAction, string> = {
  create: 'mdi-account-plus-outline',
  password: 'mdi-key-variant',
  lock: 'mdi-lock-outline',
  unlock: 'mdi-lock-open-variant-outline',
  grant: 'mdi-shield-key-outline',
  drop: 'mdi-account-remove-outline'
}

const blank = (): UserActionForm => ({
  user: '',
  host: '%',
  password: '',
  plugin: '',
  schema: '',
  withGrantOption: false
})
const form = ref<UserActionForm>(blank())
const showPassword = ref(false)

watch(open, (value) => {
  if (value) {
    form.value = { ...blank(), ...props.initial }
    showPassword.value = false
  }
})

const identityEditable = computed(() => props.action === 'create')
const needsPassword = computed(() => props.action === 'create' || props.action === 'password')
const error = computed(() => validateUserForm(props.action, form.value))
const preview = computed(() => (error.value ? '' : userActionSql(props.action, form.value, true)))
const schemaItems = computed(() => [
  { title: 'Todas (*.*)', value: '*' },
  ...props.schemas.map((s) => ({ title: s, value: s }))
])

function submit(): void {
  if (error.value || props.busy) return
  emit('apply', { ...form.value })
}
</script>

<template>
  <v-dialog v-model="open" max-width="560" :persistent="busy">
    <v-card :class="{ 'nd-danger-card': action === 'drop' }">
      <v-card-title class="d-flex align-center ga-3">
        <span class="nd-icon-badge" :class="{ 'nd-icon-badge--danger': action === 'drop' }">
          <v-icon :icon="ICONS[action]" size="18" />
        </span>
        {{ TITLES[action] }}
      </v-card-title>
      <v-card-text>
        <v-row dense>
          <v-col cols="7">
            <v-text-field
              v-model="form.user"
              label="Usuario"
              :readonly="!identityEditable"
              autocomplete="off"
              data-test="user-name"
            />
          </v-col>
          <v-col cols="5">
            <v-text-field
              v-model="form.host"
              label="Host"
              :readonly="!identityEditable"
              hint="% = cualquier host"
              data-test="user-host"
            />
          </v-col>
          <v-col v-if="needsPassword" cols="12">
            <v-text-field
              v-model="form.password"
              :label="action === 'password' ? 'Nueva contraseña' : 'Contraseña'"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="new-password"
              :append-inner-icon="showPassword ? 'mdi-eye-off' : 'mdi-eye'"
              data-test="user-password"
              @click:append-inner="showPassword = !showPassword"
            />
          </v-col>
          <v-col v-if="action === 'create'" cols="12">
            <v-select
              v-model="form.plugin"
              :items="[{ title: 'Predeterminado del servidor', value: '' }, ...AUTH_PLUGINS]"
              label="Plugin de autenticación"
            />
          </v-col>
          <template v-if="action === 'grant'">
            <v-col cols="12">
              <v-select
                v-model="form.schema"
                :items="schemaItems"
                label="Base de datos"
                data-test="user-schema"
              />
            </v-col>
            <v-col cols="12">
              <v-checkbox
                v-model="form.withGrantOption"
                label="Permitir que otorgue privilegios (WITH GRANT OPTION)"
                density="compact"
                hide-details
              />
            </v-col>
          </template>
        </v-row>
        <div class="user-sql__label">SQL que se ejecutará</div>
        <pre v-if="preview" class="user-sql" data-test="user-sql">{{ preview }}</pre>
        <div v-else class="user-sql__error">
          <v-icon icon="mdi-alert-outline" size="14" />
          {{ error }}
        </div>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn :disabled="busy" @click="open = false">Cancelar</v-btn>
        <v-btn
          :color="action === 'drop' ? 'error' : 'primary'"
          variant="flat"
          :disabled="!!error"
          :loading="busy"
          data-test="user-apply"
          @click="submit"
        >
          Aplicar
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.user-sql__label {
  margin: 16px 0 6px;
  font-size: var(--nd-fs-small);
  font-weight: 600;
  color: var(--nd-text-2);
}
.user-sql {
  margin: 0;
  padding: 10px 12px;
  max-height: 180px;
  overflow: auto;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--nd-text);
  border-radius: var(--nd-radius-control);
  background: var(--nd-bg-sunken);
  border: 1px solid var(--nd-border);
}
.user-sql__error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-warning);
  border-radius: var(--nd-radius-control);
  background: var(--nd-warning-soft);
  border: 1px solid color-mix(in srgb, var(--nd-warning) 30%, transparent);
}
</style>
