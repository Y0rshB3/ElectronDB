<script setup lang="ts">
import type { BackupFile } from '@shared/types'
import { sourceChip } from './backupHelpers'

/** Who created a backup (Navicat / Vortaq), as a small tinted pill. */
defineProps<{ source: BackupFile['source'] }>()
</script>

<template>
  <span class="nd-pill source-pill" :class="`source-pill--${source}`">
    <span class="source-pill__dot" aria-hidden="true" />{{ sourceChip(source).label }}
  </span>
</template>

<style scoped>
.source-pill__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.source-pill--electrondb {
  color: var(--nd-accent);
  background: var(--nd-accent-gradient-soft);
  border-color: rgba(var(--nd-accent-rgb), 0.3);
}
/* Provenance is neutral information: no warning tint. */
.source-pill--navicat {
  color: var(--nd-text-2);
}
</style>
