import { acceptCompletion } from '@codemirror/autocomplete'
import { indentLess, indentMore } from '@codemirror/commands'
import { Prec, type Extension } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'

/**
 * Tab accepts an open autocomplete suggestion, otherwise indents the line(s);
 * Shift-Tab dedents. CodeMirror leaves Tab unbound by default (focus moves out
 * of the editor), which is not what a SQL editor user expects.
 */
export function tabKeymap(): Extension {
  return Prec.high(
    keymap.of([
      {
        key: 'Tab',
        run: (view: EditorView) => acceptCompletion(view) || indentMore(view),
        preventDefault: true
      },
      { key: 'Shift-Tab', run: indentLess, preventDefault: true }
    ])
  )
}
