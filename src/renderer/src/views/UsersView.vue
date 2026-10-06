<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { UserInfo } from '@shared/types'
import { api } from '@renderer/api'
import EmptyState from '@renderer/components/common/EmptyState.vue'
import UserActionDialog from '@renderer/components/data/UserActionDialog.vue'
import { firstError, friendlyError, isPrivilegeError } from '@renderer/components/data/privileges'
import {
  userActionSql,
  type UserAction,
  type UserActionForm
} from '@renderer/components/data/userSql'
import { useConfirm } from '@renderer/composables/useConfirm'
import { errorMessage, useNotify } from '@renderer/composables/useNotify'
import type { WorkspaceTab } from '@renderer/stores/tabs'

const props = defineProps<{ tab: WorkspaceTab }>()

const notify = useNotify()
const { confirmDestructive } = useConfirm()

const users = ref<UserInfo[]>([])
const schemas = ref<string[]>([])
const loading = ref(false)
const busy = ref(false)
const loadError = ref<string | null>(null)
const search = ref('')

const dialogOpen = ref(false)
const dialogAction = ref<UserAction>('create')
const dialogInitial = ref<Partial<UserActionForm>>({})

const connectionId = computed(() => props.tab.connectionId ?? '')

const headers = [
  { title: 'Usuario', key: 'user' },
  { title: 'Host', key: 'host' },
  { title: 'Plugin', key: 'plugin' },
  { title: 'Estado', key: 'accountLocked', width: '112px' },
  { title: 'Contraseña caducada', key: 'passwordExpired', width: '160px' },
  { title: 'Máx. conexiones', key: 'maxConnections', align: 'end' as const, width: '130px' },
  { title: '', key: 'actions', sortable: false, align: 'end' as const, width: '136px' }
]

async function load(): Promise<void> {
  if (!connectionId.value) {
    loadError.value = 'La pestaña no tiene una conexión asociada'
    return
  }
  loading.value = true
  loadError.value = null
  try {
    users.value = await api.invokeSilent('db:users', connectionId.value)
  } catch (err) {
    const message = errorMessage(err)
    loadError.value = isPrivilegeError(message)
      ? 'La cuenta conectada no puede leer la lista de usuarios (requiere SELECT sobre mysql.user o CREATE USER).'
      : message
  } finally {
    loading.value = false
  }
  try {
    schemas.value = (await api.db.databases(connectionId.value)).map((d) => d.name)
  } catch {
    schemas.value = []
  }
}

function openDialog(action: UserAction, user?: UserInfo): void {
  dialogAction.value = action
  dialogInitial.value = user ? { user: user.user, host: user.host } : {}
  dialogOpen.value = true
}

async function quickAction(action: UserAction, user: UserInfo): Promise<void> {
  // Lock/unlock/drop need no extra input, but we still show the SQL before running it.
  const form: UserActionForm = {
    user: user.user,
    host: user.host,
    password: '',
    plugin: '',
    schema: '',
    withGrantOption: false
  }
  await run(action, form)
}

async function run(action: UserAction, form: UserActionForm): Promise<void> {
  const preview = userActionSql(action, form, true)
  const ok = await confirmDestructive({
    connectionId: connectionId.value,
    title: action === 'drop' ? 'Eliminar usuario' : 'Administrar usuario',
    message:
      action === 'drop'
        ? `Se eliminará la cuenta ${form.user}@${form.host}.`
        : 'Se ejecutará el siguiente SQL.',
    details: preview,
    confirmText: action === 'drop' ? 'Eliminar' : 'Ejecutar',
    alwaysAsk: !dialogOpen.value,
    destructive:
      action === 'drop'
        ? {
            title: `¿Eliminar el usuario «${form.user}@${form.host}»?`,
            message: 'Se eliminará la cuenta y sus privilegios. Esta acción no se puede deshacer.',
            items: [{ tag: 'DROP USER', text: `${form.user}@${form.host}` }],
            confirmText: 'Eliminar'
          }
        : undefined
  })
  if (!ok) return
  busy.value = true
  try {
    const results = await api.invokeSilent(
      'db:execute',
      connectionId.value,
      userActionSql(action, form),
      {
        confirmProduction: true
      }
    )
    const error = firstError(results)
    if (error) {
      notify.error(friendlyError(error))
      return
    }
    dialogOpen.value = false
    notify.success('Operación completada')
    await load()
  } catch (err) {
    notify.error(friendlyError(errorMessage(err)))
  } finally {
    busy.value = false
  }
}

onMounted(load)

defineExpose({ users, run })
</script>

<template>
  <div class="nd-view users-view">
    <div class="nd-viewbar" role="toolbar" aria-label="Acciones de usuarios">
      <v-btn
        prepend-icon="mdi-account-plus-outline"
        size="small"
        color="primary"
        variant="flat"
        :disabled="!!loadError"
        data-test="new-user"
        @click="openDialog('create')"
      >
        Nuevo usuario
      </v-btn>
      <v-btn prepend-icon="mdi-refresh" size="small" class="ml-1" :loading="loading" @click="load"
        >Refrescar</v-btn
      >
      <span class="nd-viewbar__spacer" />
      <span v-if="!loadError && users.length" class="users-view__count mr-3"
        >{{ users.length }} cuenta(s)</span
      >
      <v-text-field
        v-model="search"
        density="compact"
        placeholder="Buscar"
        prepend-inner-icon="mdi-magnify"
        aria-label="Buscar usuarios"
        hide-details
        clearable
        class="users-view__search"
      />
    </div>

    <EmptyState
      v-if="loadError"
      icon="mdi-account-lock-outline"
      title="No se pudieron cargar los usuarios"
      :description="loadError"
    >
      <v-btn variant="tonal" size="small" prepend-icon="mdi-refresh" @click="load"
        >Reintentar</v-btn
      >
    </EmptyState>
    <div v-else class="nd-viewpanel">
      <v-data-table
        :headers="headers"
        :items="users"
        :search="search"
        :loading="loading"
        :items-per-page="-1"
        :item-value="(u: UserInfo) => `${u.user}@${u.host}`"
        density="compact"
        fixed-header
        hide-default-footer
        class="users-view__table"
        no-data-text="No hay usuarios"
        loading-text="Cargando usuarios…"
      >
        <template #[`item.user`]="{ item }">
          <span class="users-view__user">
            <span class="users-view__avatar" aria-hidden="true">
              <v-icon icon="mdi-account-outline" size="14" />
            </span>
            <span class="nd-ellipsis" :title="item.user">{{ item.user }}</span>
          </span>
        </template>
        <template #[`item.host`]="{ item }">
          <span class="nd-mono users-view__host" :title="item.host">{{ item.host }}</span>
        </template>
        <template #[`item.plugin`]="{ item }">
          <span class="nd-mono users-view__plugin">{{ item.plugin }}</span>
        </template>
        <template #[`item.accountLocked`]="{ item }">
          <span
            class="nd-pill"
            :class="item.accountLocked ? 'nd-pill--production' : 'nd-pill--local'"
          >
            <v-icon :icon="item.accountLocked ? 'mdi-lock' : 'mdi-check'" size="11" />
            {{ item.accountLocked ? 'Bloqueada' : 'Activa' }}
          </span>
        </template>
        <template #[`item.passwordExpired`]="{ item }">
          <span v-if="item.passwordExpired" class="nd-pill nd-pill--staging">Sí</span>
          <span v-else class="nd-muted">No</span>
        </template>
        <template #[`item.maxConnections`]="{ item }">
          <span v-if="item.maxConnections" class="nd-num">{{ item.maxConnections }}</span>
          <span v-else class="nd-muted">Sin límite</span>
        </template>
        <template #[`item.actions`]="{ item }">
          <div class="users-view__actions">
            <v-btn
              icon="mdi-key-variant"
              size="x-small"
              :aria-label="`Cambiar contraseña de ${item.user}`"
              title="Cambiar contraseña"
              @click="openDialog('password', item)"
            />
            <v-btn
              :icon="item.accountLocked ? 'mdi-lock-open-variant-outline' : 'mdi-lock-outline'"
              size="x-small"
              :aria-label="
                item.accountLocked ? `Desbloquear ${item.user}` : `Bloquear ${item.user}`
              "
              :title="item.accountLocked ? 'Desbloquear' : 'Bloquear'"
              @click="quickAction(item.accountLocked ? 'unlock' : 'lock', item)"
            />
            <v-btn
              icon="mdi-shield-key-outline"
              size="x-small"
              :aria-label="`Otorgar privilegios a ${item.user}`"
              title="Otorgar privilegios"
              @click="openDialog('grant', item)"
            />
            <v-btn
              icon="mdi-delete-outline"
              size="x-small"
              color="error"
              :aria-label="`Eliminar ${item.user}`"
              title="Eliminar usuario"
              @click="quickAction('drop', item)"
            />
          </div>
        </template>
      </v-data-table>
    </div>

    <UserActionDialog
      v-model="dialogOpen"
      :action="dialogAction"
      :initial="dialogInitial"
      :schemas="schemas"
      :busy="busy"
      @apply="run(dialogAction, $event)"
    />
  </div>
</template>

<style scoped src="../components/data/viewChrome.css"></style>
<style scoped>
.users-view__count {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
  white-space: nowrap;
}
.users-view__search {
  flex: 0 1 260px;
  min-width: 160px;
  max-width: 260px;
}
.users-view__table {
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
}
.users-view__user {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  max-width: 100%;
  font-weight: 500;
}
.users-view__avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  color: var(--nd-accent);
  background: var(--nd-accent-gradient-soft);
  border: 1px solid rgba(var(--nd-accent-rgb), 0.22);
}
.users-view__host {
  font-size: var(--nd-fs-small);
}
.users-view__plugin {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.users-view__actions {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
  opacity: 0.7;
  transition: opacity var(--nd-dur-fast) var(--nd-ease);
}
.users-view__table :deep(tbody tr:hover) .users-view__actions,
.users-view__actions:focus-within {
  opacity: 1;
}
</style>
