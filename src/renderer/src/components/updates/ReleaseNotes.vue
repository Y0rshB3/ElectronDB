<script setup lang="ts">
import { computed, h, type VNode } from 'vue'
import { parseMarkdown, type Block, type Inline } from './markdown'

/**
 * Release notes from GitHub rendered from a markdown subset. Built with text
 * nodes only (no v-html): any HTML in the notes is displayed as text.
 */
const props = defineProps<{ source: string }>()

const blocks = computed(() => parseMarkdown(props.source))

function inline(nodes: Inline[]): (VNode | string)[] {
  return nodes.map((n) => {
    switch (n.type) {
      case 'text':
        return n.text
      case 'code':
        return h('code', n.text)
      case 'strong':
        return h('strong', inline(n.children))
      case 'em':
        return h('em', inline(n.children))
    }
  })
}

function block(b: Block): VNode {
  switch (b.type) {
    case 'heading':
      // Release titles are already shown by the dialog: notes headings start at h3.
      return h(
        `h${Math.min(6, b.level + 2)}`,
        { class: 'release-notes__heading' },
        inline(b.children)
      )
    case 'paragraph':
      return h('p', inline(b.children))
    case 'list':
      return h(
        b.ordered ? 'ol' : 'ul',
        b.items.map((item) =>
          h('li', [
            ...inline(item.content),
            ...(item.children.length
              ? [
                  h(
                    'ul',
                    item.children.map((child) => h('li', inline(child)))
                  )
                ]
              : [])
          ])
        )
      )
    case 'code':
      return h('pre', h('code', b.text))
    case 'quote':
      return h('blockquote', inline(b.children))
    case 'rule':
      return h('hr')
    case 'table':
      return h('div', { class: 'release-notes__table' }, [
        h('table', [
          h(
            'thead',
            h(
              'tr',
              b.header.map((cell) => h('th', inline(cell)))
            )
          ),
          h(
            'tbody',
            b.rows.map((row) =>
              h(
                'tr',
                row.map((cell) => h('td', inline(cell)))
              )
            )
          )
        ])
      ])
  }
}

const Notes = () => blocks.value.map(block)
</script>

<template>
  <div class="release-notes" data-test="release-notes">
    <Notes v-if="blocks.length" />
    <p v-else class="release-notes__empty">Esta versión no incluye notas.</p>
  </div>
</template>

<style scoped>
.release-notes {
  font-size: var(--nd-fs-dense);
  line-height: 1.55;
  color: var(--nd-text);
  overflow-wrap: anywhere;
}
.release-notes :deep(> :first-child) {
  margin-top: 0;
}
.release-notes :deep(> :last-child) {
  margin-bottom: 0;
}
.release-notes :deep(.release-notes__heading) {
  margin: 14px 0 6px;
  font-size: var(--nd-fs-base);
  font-weight: var(--nd-fw-heading);
  color: var(--nd-text);
}
.release-notes :deep(p) {
  margin: 0 0 8px;
}
.release-notes :deep(ul),
.release-notes :deep(ol) {
  margin: 0 0 8px;
  padding-left: 20px;
}
.release-notes :deep(li > ul) {
  margin: 2px 0 0;
  padding-left: 18px;
}
.release-notes :deep(li) {
  margin: 2px 0;
}
.release-notes :deep(li::marker) {
  color: var(--nd-accent);
}
.release-notes :deep(code) {
  font-family: var(--nd-font-mono);
  font-size: 0.92em;
  padding: 1px 5px;
  border-radius: var(--nd-radius-sm);
  background: var(--nd-bg-sunken);
  border: 1px solid var(--nd-hairline);
}
.release-notes :deep(pre) {
  margin: 0 0 8px;
  padding: 8px 10px;
  border-radius: var(--nd-radius-control);
  background: var(--nd-bg-sunken);
  border: 1px solid var(--nd-border);
  overflow-x: auto;
}
.release-notes :deep(pre code) {
  padding: 0;
  border: 0;
  background: none;
}
.release-notes :deep(blockquote) {
  margin: 0 0 8px;
  padding: 2px 10px;
  border-left: 2px solid var(--nd-border-strong);
  color: var(--nd-text-2);
}
.release-notes :deep(hr) {
  border: 0;
  border-top: 1px solid var(--nd-border);
  margin: 12px 0;
}
.release-notes :deep(.release-notes__table) {
  margin: 0 0 8px;
  overflow-x: auto;
}
.release-notes :deep(table) {
  border-collapse: collapse;
  font-size: var(--nd-fs-small);
}
.release-notes :deep(th),
.release-notes :deep(td) {
  padding: 4px 10px;
  border: 1px solid var(--nd-border);
  text-align: left;
  vertical-align: top;
}
.release-notes :deep(th) {
  font-weight: 600;
  background: var(--nd-bg-sunken);
}
.release-notes__empty {
  margin: 0;
  color: var(--nd-text-2);
}
</style>
