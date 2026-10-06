import { shallowReactive } from 'vue'

/**
 * Query editors currently mounted, by tab id. Lets the AI panel read the
 * active editor's connection, database and SQL and insert generated SQL at
 * the cursor. Inserting never runs anything: the user runs it through the
 * normal guards.
 */
export interface QueryEditorHandle {
  tabId: string
  connectionId(): string
  schema(): string | null
  sql(): string
  selection(): string
  insertAtCursor(text: string): void
}

const editors = shallowReactive(new Map<string, QueryEditorHandle>())

export function registerQueryEditor(handle: QueryEditorHandle): () => void {
  editors.set(handle.tabId, handle)
  return () => {
    if (editors.get(handle.tabId) === handle) editors.delete(handle.tabId)
  }
}

export function queryEditorFor(tabId: string | null | undefined): QueryEditorHandle | undefined {
  return tabId ? editors.get(tabId) : undefined
}
