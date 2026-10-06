import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import { tabKeymap } from './tabKeymap'

function press(view: EditorView, key: string, shiftKey = false): boolean {
  return runScopeHandlers(view, new KeyboardEvent('keydown', { key, shiftKey }), 'editor')
}

describe('tabKeymap', () => {
  it('indents with Tab and dedents with Shift-Tab instead of leaving the editor', () => {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: 'SELECT 1', extensions: [tabKeymap()] })
    })
    expect(press(view, 'Tab')).toBe(true)
    expect(view.state.doc.toString()).toMatch(/^\s+SELECT 1$/)
    expect(press(view, 'Tab', true)).toBe(true)
    expect(view.state.doc.toString()).toBe('SELECT 1')
    view.destroy()
  })
})
