<script setup lang="ts">
import { computed, h, type FunctionalComponent, type VNode } from 'vue'
import { parseMarkdown, type Inline } from '@renderer/components/updates/markdown'

/**
 * Assistant answer rendered from a markdown subset with text nodes only (no
 * v-html): HTML in an answer is displayed as text, never injected. Code blocks
 * offer «Insertar en el editor» (SQL only, never executed) and «Copiar».
 */
const props = defineProps<{ source: string; streaming?: boolean }>()
const emit = defineEmits<{ insert: [sql: string]; copy: [text: string] }>()

const blocks = computed(() => parseMarkdown(props.source))

const SQL_LANGS = new Set(['', 'sql', 'mysql'])
const isSql = (lang: string | undefined): boolean => SQL_LANGS.has(lang ?? '')

function inline(nodes: Inline[]): (VNode | string)[] {
  return nodes.map((n) => {
    switch (n.type) {
      case 'text':
        return n.text
      case 'code':
        return h('code', { class: 'chat-md__inline-code' }, n.text)
      case 'strong':
        return h('strong', inline(n.children))
      case 'em':
        return h('em', inline(n.children))
    }
  })
}

const Inlines: FunctionalComponent<{ nodes: Inline[] }> = (p) => inline(p.nodes)
Inlines.props = ['nodes']
</script>

<template>
  <div class="chat-md">
    <template v-for="(b, i) in blocks" :key="i">
      <component
        :is="`h${Math.min(6, b.level + 3)}`"
        v-if="b.type === 'heading'"
        class="chat-md__h"
      >
        <Inlines :nodes="b.children" />
      </component>
      <p v-else-if="b.type === 'paragraph'"><Inlines :nodes="b.children" /></p>
      <component :is="b.ordered ? 'ol' : 'ul'" v-else-if="b.type === 'list'">
        <li v-for="(item, j) in b.items" :key="j">
          <Inlines :nodes="item.content" />
          <ul v-if="item.children.length">
            <li v-for="(child, k) in item.children" :key="k"><Inlines :nodes="child" /></li>
          </ul>
        </li>
      </component>
      <div v-else-if="b.type === 'code'" class="chat-md__code" data-test="ai-code-block">
        <div class="chat-md__code-bar">
          <span class="chat-md__lang">{{ b.lang || 'sql' }}</span>
          <span class="chat-md__spacer" />
          <v-btn
            v-if="isSql(b.lang)"
            size="x-small"
            variant="tonal"
            color="primary"
            prepend-icon="mdi-arrow-collapse-down"
            :disabled="streaming"
            title="Insertar en el editor de consultas (no se ejecuta)"
            data-test="ai-insert-sql"
            @click="emit('insert', b.text)"
            >Insertar en el editor</v-btn
          >
          <v-btn
            size="x-small"
            variant="text"
            prepend-icon="mdi-content-copy"
            title="Copiar al portapapeles"
            data-test="ai-copy-code"
            @click="emit('copy', b.text)"
            >Copiar</v-btn
          >
        </div>
        <pre class="chat-md__pre"><code>{{ b.text }}</code></pre>
      </div>
      <blockquote v-else-if="b.type === 'quote'"><Inlines :nodes="b.children" /></blockquote>
      <hr v-else-if="b.type === 'rule'" />
      <div v-else-if="b.type === 'table'" class="chat-md__table">
        <table>
          <thead>
            <tr>
              <th v-for="(cell, j) in b.header" :key="j"><Inlines :nodes="cell" /></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, j) in b.rows" :key="j">
              <td v-for="(cell, k) in row" :key="k"><Inlines :nodes="cell" /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chat-md {
  font-size: var(--nd-fs-small);
  line-height: 1.55;
  color: var(--nd-text);
  overflow-wrap: anywhere;
}
.chat-md > :first-child {
  margin-top: 0;
}
.chat-md > :last-child {
  margin-bottom: 0;
}
.chat-md p,
.chat-md ul,
.chat-md ol,
.chat-md blockquote {
  margin: 0 0 8px;
}
.chat-md ul,
.chat-md ol {
  padding-left: 20px;
}
.chat-md__h {
  margin: 10px 0 6px;
  font-size: var(--nd-fs-small);
  font-weight: 600;
}
.chat-md blockquote {
  padding: 4px 10px;
  border-left: 3px solid var(--nd-border-strong);
  color: var(--nd-text-2);
}
.chat-md__inline-code {
  padding: 0 4px;
  border-radius: 4px;
  font-family: var(--nd-font-mono);
  font-size: 0.92em;
  background: var(--nd-bg-input);
  color: var(--nd-text);
}
.chat-md__code {
  margin: 0 0 10px;
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-control);
  background: var(--nd-bg-input);
  overflow: hidden;
}
.chat-md__code-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px 3px 10px;
  border-bottom: 1px solid var(--nd-hairline);
  background: var(--nd-bg-raised);
}
.chat-md__lang {
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-muted);
  text-transform: uppercase;
}
.chat-md__spacer {
  flex: 1;
}
.chat-md__pre {
  margin: 0;
  padding: 8px 10px;
  overflow-x: auto;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
  line-height: 1.5;
  /* Narrow side panel: wrap long SQL lines instead of hiding them behind a scrollbar. */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.chat-md__table {
  overflow-x: auto;
  margin: 0 0 8px;
}
.chat-md__table table {
  border-collapse: collapse;
  font-size: var(--nd-fs-dense);
}
.chat-md__table th,
.chat-md__table td {
  padding: 3px 8px;
  border: 1px solid var(--nd-border);
  text-align: left;
}
.chat-md hr {
  border: 0;
  border-top: 1px solid var(--nd-border);
  margin: 10px 0;
}
</style>
