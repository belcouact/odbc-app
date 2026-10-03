import { useMemo } from 'react'
import CodeMirror, { EditorView, Prec, keymap } from '@uiw/react-codemirror'
import { acceptCompletion } from '@codemirror/autocomplete'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'

export type CodeEditorLanguage = 'sql' | 'python'

interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  language: CodeEditorLanguage
  placeholder?: string
  /** Accessibility label forwarded to the editor container. */
  ariaLabel?: string
  minHeight?: string
  maxHeight?: string
}

/** Code editor used for SQL queries and Python scripts (CodeMirror 6, bundled). */
export default function CodeEditor({
  value,
  onChange,
  language,
  placeholder,
  ariaLabel,
  minHeight = '170px',
  maxHeight = '400px',
}: CodeEditorProps) {
  const extensions = useMemo(
    () => [
      language === 'sql' ? sql() : python(),
      EditorView.lineWrapping,
      // Enter/Tab accept the highlighted completion. Enter is already bound by
      // CodeMirror's default completion keymap, but Tab is not — bind both
      // explicitly at highest precedence so they can never be shadowed. Both
      // return false when no popup is open, so Enter still makes newlines.
      Prec.highest(
        keymap.of([
          { key: 'Enter', run: acceptCompletion },
          { key: 'Tab', run: acceptCompletion },
        ]),
      ),
    ],
    [language],
  )

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      placeholder={placeholder}
      aria-label={ariaLabel}
      minHeight={minHeight}
      maxHeight={maxHeight}
      style={{ fontFamily: 'Consolas, monospace', fontSize: '0.9rem' }}
    />
  )
}
