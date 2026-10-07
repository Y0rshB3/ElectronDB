<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AppInfo, AppLicenses } from '@shared/types'
import { api } from '@renderer/api'
import appIcon from '@renderer/assets/app-icon.png'
import { errorMessage } from '@renderer/composables/useNotify'
import { useUiStore } from '@renderer/stores/ui'
import { runSafely } from '@renderer/utils/errors'
import { filterNotices, splitNotices } from './aboutNotices'

/**
 * «Acerca de Vortaq» (Más › Acerca de Vortaq): version, MIT licence, the
 * project repository, the trademark note and a viewer for the third-party
 * notices shipped with the app (THIRD_PARTY_LICENSES.txt).
 */
const ui = useUiStore()

type View = 'about' | 'license' | 'thirdParty'
const view = ref<View>('about')
const info = ref<AppInfo | null>(null)
const licenses = ref<AppLicenses | null>(null)
const loading = ref(false)
const error = ref('')
const query = ref('')

const open = computed({
  get: () => ui.aboutDialog,
  set: (value: boolean) => {
    ui.aboutDialog = value
  }
})

const notices = computed(() => splitNotices(licenses.value?.thirdParty ?? ''))
const visibleNotices = computed(() => filterNotices(notices.value.sections, query.value))

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [appInfo, texts] = await Promise.all([api.app.info(), api.app.licenses()])
    info.value = appInfo
    licenses.value = texts
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    loading.value = false
  }
}

watch(open, (value) => {
  if (!value) return
  view.value = 'about'
  query.value = ''
  void load()
})

function openNoticesFile(): void {
  const path = licenses.value?.thirdPartyPath
  if (path) runSafely(() => api.app.openPath(path))
}
</script>

<template>
  <v-dialog v-model="open" max-width="640" scrollable>
    <v-card class="about" data-test="about-dialog">
      <template v-if="view === 'about'">
        <v-card-text class="about__main">
          <img :src="appIcon" class="about__icon" alt="" width="88" height="88" />
          <h2 class="about__name">Vortaq</h2>
          <p class="about__version nd-mono" data-test="about-version">
            <template v-if="info">
              Versión {{ info.version }} · Electron {{ info.electron }}
            </template>
            <template v-else>&nbsp;</template>
          </p>
          <p class="about__tagline">
            Gestor de bases de datos de escritorio, independiente y de código abierto.
          </p>
          <p class="about__license">
            Software libre con licencia MIT · © 2026 Y0rshB3.
            <a href="#" data-test="about-show-license" @click.prevent="view = 'license'"
              >Ver licencia</a
            >
          </p>
          <div class="about__actions">
            <v-btn
              variant="tonal"
              prepend-icon="mdi-github"
              data-test="about-repository"
              @click="runSafely(() => api.app.openRepository())"
              >Repositorio en GitHub</v-btn
            >
            <v-btn
              variant="tonal"
              prepend-icon="mdi-scale-balance"
              data-test="about-third-party"
              @click="view = 'thirdParty'"
              >Licencias de terceros</v-btn
            >
          </div>
          <v-alert
            v-if="error"
            type="error"
            variant="tonal"
            density="compact"
            class="mt-3 text-left"
            >{{ error }}</v-alert
          >
          <p class="about__trademarks">
            Vortaq es un proyecto independiente y no está afiliado, patrocinado ni respaldado por
            PremiumSoft CyberTech Ltd. ni por ningún otro fabricante. Navicat® es marca de
            PremiumSoft CyberTech Ltd.; MySQL® es marca de Oracle; Electron® es marca de la OpenJS
            Foundation; las demás marcas pertenecen a sus propietarios y se citan solo para indicar
            compatibilidad.
          </p>
        </v-card-text>
      </template>

      <template v-else>
        <div class="about__subhead">
          <v-btn
            variant="text"
            size="small"
            prepend-icon="mdi-arrow-left"
            data-test="about-back"
            @click="view = 'about'"
            >Volver</v-btn
          >
          <h2 class="about__subtitle">
            {{ view === 'license' ? 'Licencia de Vortaq' : 'Licencias de terceros' }}
          </h2>
        </div>
        <v-card-text v-if="view === 'license'" class="about__scroll">
          <pre class="about__text" data-test="about-license-text">{{
            licenses?.license ?? 'No se encontró el archivo LICENSE.'
          }}</pre>
        </v-card-text>
        <template v-else>
          <div v-if="licenses?.thirdParty" class="about__filter">
            <v-text-field
              v-model="query"
              density="compact"
              variant="outlined"
              hide-details
              clearable
              prepend-inner-icon="mdi-magnify"
              label="Buscar componente"
              data-test="about-notices-filter"
            />
            <span class="about__count nd-mono" data-test="about-notices-count"
              >{{ visibleNotices.length }} / {{ notices.sections.length }}</span
            >
          </div>
          <v-card-text class="about__scroll">
            <template v-if="licenses?.thirdParty">
              <pre v-if="!query" class="about__text about__header">{{ notices.header }}</pre>
              <v-expansion-panels variant="accordion" class="mt-2" data-test="about-notices">
                <v-expansion-panel v-for="s in visibleNotices" :key="s.title">
                  <v-expansion-panel-title class="nd-mono">{{ s.title }}</v-expansion-panel-title>
                  <v-expansion-panel-text>
                    <pre class="about__text">{{ s.body }}</pre>
                  </v-expansion-panel-text>
                </v-expansion-panel>
              </v-expansion-panels>
            </template>
            <v-alert v-else-if="!loading" type="info" variant="tonal" density="compact">
              La lista de licencias de terceros se genera al compilar la aplicación (<code
                >npm run build</code
              >) y no está disponible en esta copia.
            </v-alert>
          </v-card-text>
        </template>
      </template>

      <v-card-actions>
        <v-btn
          v-if="view === 'thirdParty' && licenses?.thirdPartyPath"
          variant="text"
          prepend-icon="mdi-file-document-outline"
          data-test="about-open-notices"
          @click="openNoticesFile"
          >Abrir archivo</v-btn
        >
        <v-spacer />
        <v-btn variant="text" data-test="about-close" @click="open = false">Cerrar</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.about__main {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 28px 28px 8px !important;
}
.about__icon {
  width: 88px;
  height: 88px;
  margin-bottom: 10px;
}
.about__name {
  margin: 0;
  font-size: 22px;
  font-weight: var(--nd-fw-heading);
  color: var(--nd-text);
}
.about__version {
  margin: 2px 0 10px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.about__tagline {
  margin: 0 0 6px;
  color: var(--nd-text);
}
.about__license {
  margin: 0 0 14px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text-2);
}
.about__license a {
  color: var(--nd-accent);
}
.about__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}
.about__trademarks {
  margin: 18px 0 0;
  font-size: var(--nd-fs-xs);
  line-height: 1.5;
  color: var(--nd-text-muted);
}
.about__subhead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px 4px;
}
.about__subtitle {
  margin: 0;
  font-size: var(--nd-fs-heading);
  font-weight: var(--nd-fw-heading);
}
.about__filter {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 24px 8px;
}
.about__count {
  flex: none;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.about__scroll {
  max-height: 60vh;
}
.about__text {
  margin: 0;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--nd-text-2);
}
</style>
