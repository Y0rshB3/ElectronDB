<script setup lang="ts">
defineProps<{
  icon?: string
  title: string
  description?: string
  /** `compact` fits narrow side panels (smaller halo, tighter spacing). */
  size?: 'default' | 'compact'
}>()
</script>

<template>
  <div class="empty-state" :class="{ 'empty-state--compact': size === 'compact' }" role="status">
    <div class="empty-state__halo" aria-hidden="true">
      <v-icon
        :icon="icon ?? 'mdi-information-outline'"
        :size="size === 'compact' ? 24 : 34"
        class="empty-state__icon"
      />
    </div>
    <div class="empty-state__title">{{ title }}</div>
    <div v-if="description" class="empty-state__desc">
      {{ description }}
    </div>
    <div v-if="$slots.default" class="empty-state__actions">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 32px 20px;
  height: 100%;
  min-height: 0;
}
.empty-state__halo {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 72px;
  height: 72px;
  margin-bottom: 16px;
  border-radius: 50%;
  background:
    radial-gradient(circle at 30% 25%, rgba(var(--nd-accent-rgb), 0.14), transparent 70%),
    radial-gradient(circle at 75% 80%, rgba(var(--nd-violet-rgb), 0.14), transparent 70%);
  border: 1px solid var(--nd-border);
  box-shadow: var(--nd-shadow-inset);
}
.empty-state__halo::after {
  content: '';
  position: absolute;
  inset: -7px;
  border-radius: 50%;
  border: 1px dashed var(--nd-hairline);
}
/* Thin glyph filled with the accent gradient (mdi icons render through ::before). */
.empty-state__icon {
  background: var(--nd-accent-gradient);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
}
.empty-state__title {
  font-size: var(--nd-fs-title);
  font-weight: var(--nd-fw-heading);
  color: var(--nd-text);
}
.empty-state__desc {
  max-width: 420px;
  margin-top: 6px;
  font-size: var(--nd-fs-base);
  color: var(--nd-text-2);
  line-height: 1.5;
}
.empty-state__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 18px;
}

/* Compact variant for side panels. */
.empty-state--compact {
  justify-content: flex-start;
  padding: 36px 14px 20px;
  height: auto;
}
.empty-state--compact .empty-state__halo {
  width: 52px;
  height: 52px;
  margin-bottom: 12px;
}
.empty-state--compact .empty-state__halo::after {
  inset: -5px;
}
.empty-state--compact .empty-state__title {
  font-size: var(--nd-fs-base);
}
.empty-state--compact .empty-state__desc {
  max-width: 240px;
  margin-top: 4px;
  font-size: var(--nd-fs-dense);
}
.empty-state--compact .empty-state__actions {
  margin-top: 14px;
}
</style>
