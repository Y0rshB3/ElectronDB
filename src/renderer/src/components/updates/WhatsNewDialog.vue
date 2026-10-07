<script setup lang="ts">
import { computed } from 'vue'
import DialogHeader from '@renderer/components/dialogs/DialogHeader.vue'
import { useWhatsNewStore } from '@renderer/stores/whatsNew'
import { formatReleaseDate } from './updateFormat'

/** «Vortaq se actualizó a x.y.z»: curated highlights of the versions just installed. */
const whatsNew = useWhatsNewStore()

const info = computed(() => whatsNew.info)
const subtitle = computed(() =>
  info.value?.previousVersion
    ? `Novedades desde la versión ${info.value.previousVersion}`
    : 'Novedades de esta versión'
)
const open = computed({
  get: () => whatsNew.open,
  set: (value: boolean) => {
    // Escape or a click outside also count as seen.
    if (!value && whatsNew.open) void whatsNew.close()
  }
})
</script>

<template>
  <v-dialog v-model="open" max-width="560" scrollable>
    <v-card v-if="info" data-test="whats-new">
      <DialogHeader
        icon="mdi-party-popper"
        :title="`Vortaq se actualizó a ${info.currentVersion}`"
        :subtitle="subtitle"
      />
      <v-card-text class="whats-new__body">
        <section
          v-for="entry in info.entries"
          :key="entry.version"
          class="whats-new__version"
          :aria-label="`Versión ${entry.version}`"
          :data-test="`whats-new-${entry.version}`"
        >
          <div class="whats-new__head">
            <span class="whats-new__tag nd-mono">{{ entry.version }}</span>
            <span class="whats-new__date">{{ formatReleaseDate(`${entry.date}T12:00:00Z`) }}</span>
          </div>
          <div
            v-for="(line, index) in entry.important ?? []"
            :key="`i${index}`"
            class="whats-new__important"
            data-test="whats-new-important"
          >
            <v-icon icon="mdi-alert-circle-outline" size="16" aria-hidden="true" />
            <span>{{ line }}</span>
          </div>
          <ul class="whats-new__list">
            <li v-for="(line, index) in entry.highlights" :key="index">
              <v-icon icon="mdi-check-circle-outline" size="16" aria-hidden="true" />
              <span>{{ line }}</span>
            </li>
          </ul>
        </section>
      </v-card-text>
      <v-card-actions>
        <v-btn
          variant="text"
          append-icon="mdi-open-in-new"
          data-test="whats-new-github"
          @click="whatsNew.openRelease()"
          >Ver todas las novedades en GitHub</v-btn
        >
        <v-spacer />
        <v-btn
          v-if="whatsNew.tourSteps.length"
          variant="tonal"
          color="primary"
          prepend-icon="mdi-map-marker-path"
          data-test="whats-new-show-me"
          @click="whatsNew.showMe()"
          >Mostrarme cómo</v-btn
        >
        <v-btn color="primary" variant="flat" data-test="whats-new-ok" @click="whatsNew.close()"
          >Entendido</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.whats-new__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 4px !important;
}
.whats-new__version {
  padding: 12px 14px;
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-border);
}
.whats-new__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}
.whats-new__tag {
  font-weight: var(--nd-fw-heading);
  color: var(--nd-accent);
}
.whats-new__date {
  font-size: var(--nd-fs-small);
  color: var(--nd-text-2);
}
.whats-new__important {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 8px;
  padding: 8px 10px;
  border-radius: var(--nd-radius-control);
  background: var(--nd-warning-soft);
  border: 1px solid color-mix(in srgb, var(--nd-warning) 35%, transparent);
  color: var(--nd-text);
  font-size: var(--nd-fs-dense);
  line-height: 1.45;
}
.whats-new__important .v-icon {
  flex: none;
  margin-top: 1px;
  color: var(--nd-warning);
}
.whats-new__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.whats-new__list li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: var(--nd-text);
  line-height: 1.45;
}
.whats-new__list .v-icon {
  flex: none;
  margin-top: 2px;
  color: var(--nd-success);
}
</style>
