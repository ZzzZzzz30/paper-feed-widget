import { useEffect, useRef } from 'react'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from '@codemirror/view'
import { Bold, List, ListOrdered } from 'lucide-react'

class Bullet extends WidgetType {
  toDOM() {
    const span = document.createElement('span')
    span.textContent = '•'
    return span
  }
}

const bullet = Decoration.replace({ widget: new Bullet() })
const hide = Decoration.replace({})
const heading = [1, 2, 3, 4, 5, 6].map(level =>
  Decoration.line({ attributes: { 'data-heading': String(level) } }),
)
const inline = new Map([
  ['StrongEmphasis', Decoration.mark({ class: 'pf-note-strong' })],
  ['Emphasis', Decoration.mark({ class: 'pf-note-emphasis' })],
  ['InlineCode', Decoration.mark({ class: 'pf-note-code' })],
])

function decorate(view: EditorView) {
  const { doc, selection } = view.state
  const ranges: Range<Decoration>[] = []
  for (const viewport of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: viewport.from,
      to: viewport.to,
      enter(node) {
        const line = doc.lineAt(node.from)
        // Keep the Markdown editable anywhere the user is typing or selecting.
        const active = selection.ranges.some(range => range.from <= line.to && range.to >= line.from)
        if (node.name === 'ListMark' && /^[ \t]*$/.test(doc.sliceString(line.from, node.from))) {
          const isBullet = node.node.parent?.parent?.name === 'BulletList'
          const hang = isBullet ? '1em' : (node.to - node.from + 1) + 'ch'
          ranges.push(Decoration.line({
            attributes: { style: 'padding-inline-start:' + hang + ';text-indent:-' + hang },
          }).range(line.from))
        }
        if (active || view.composing) return
        if (node.name.startsWith('ATXHeading')) {
          ranges.push(heading[Number(node.name.at(-1)) - 1].range(line.from))
        } else if (node.name === 'HeaderMark') {
          const trailing = doc.sliceString(node.to, line.to).match(/^[ \t]*/)?.[0].length ?? 0
          ranges.push(hide.range(node.from, node.to + trailing))
        } else if (node.name === 'EmphasisMark' || node.name === 'CodeMark' && node.node.parent?.name === 'InlineCode') {
          ranges.push(hide.range(node.from, node.to))
        } else if (node.name === 'ListMark' && node.node.parent?.parent?.name === 'BulletList') {
          ranges.push(bullet.range(node.from, node.to))
        } else {
          const mark = inline.get(node.name)
          if (mark) ranges.push(mark.range(node.from, node.to))
        }
      },
    })
  }
  return Decoration.set(ranges, true)
}

const liveMarkdown = ViewPlugin.fromClass(class {
  decorations

  constructor(view: EditorView) {
    this.decorations = decorate(view)
  }

  update(update: import('@codemirror/view').ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = decorate(update.view)
    }
  }
}, { decorations: plugin => plugin.decorations })

function toggleBold(view: EditorView): boolean {
  const { state } = view
  view.dispatch({
    ...state.changeByRange(range => {
      const { from, to } = range
      let node = syntaxTree(state).resolveInner(from, 1)
      while (node.parent && node.name !== 'StrongEmphasis') node = node.parent
      if (node.name === 'StrongEmphasis' && to <= node.to) {
        const start = Math.max(node.from, from - 2)
        const end = Math.min(node.to - 4, to - 2)
        return {
          changes: [{ from: node.from, to: node.from + 2 }, { from: node.to - 2, to: node.to }],
          range: EditorSelection.range(start, Math.max(start, end)),
        }
      }
      const text = state.sliceDoc(from, to)
      return {
        changes: { from, to, insert: '**' + text + '**' },
        range: EditorSelection.range(from + 2, to + 2),
      }
    }),
    userEvent: 'input.format',
  })
  return true
}

const blockPrefix = /^(?:(#{1,6})|([-+*])|(\d{1,9}[.)]))(?:[ \t]+|$)/

function formatLines(view: EditorView, format: number | 'bullet' | 'ordered') {
  const { doc, selection } = view.state
  const lines = new Set<number>()
  for (const range of selection.ranges) {
    const start = doc.lineAt(range.from).number
    const end = doc.lineAt(range.empty ? range.to : range.to - 1).number
    for (let number = start; number <= end; number++) lines.add(number)
  }
  const selected = [...lines].sort((a, b) => a - b).map(number => {
    const line = doc.line(number)
    const indentation = line.text.match(/^[ \t]*/)?.[0].length ?? 0
    return { line, from: line.from + indentation, prefix: line.text.slice(indentation).match(blockPrefix) }
  })
  const remove = selected.every(({ prefix }) => format === 'bullet' ? prefix?.[2] :
    format === 'ordered' ? prefix?.[3] : format === 0 || prefix?.[1]?.length === format)
  let number = 0
  let previousLine = 0
  const changes = selected.map(({ line, from, prefix }) => {
    number = line.number === previousLine + 1 ? number + 1 : 1
    previousLine = line.number
    const insert = remove || format === 0 ? '' :
      format === 'bullet' ? '- ' : format === 'ordered' ? number + '. ' : '#'.repeat(format) + ' '
    return { from, to: from + (prefix?.[0].length ?? 0), insert }
  })
  view.dispatch({ changes, userEvent: 'input.format' })
  view.focus()
}

export const noteToolClass = 'note-tool'

interface NoteEditorProps {
  body: string
  onChange: (body: string) => void
  onSave: () => void
}

export default function NoteEditor({ body, onChange, onSave }: NoteEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const callbacks = useRef({ onChange, onSave })
  callbacks.current = { onChange, onSave }

  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: body,
        extensions: [
          history(), markdown(), liveMarkdown, EditorView.lineWrapping,
          keymap.of([
            { key: 'Mod-b', run: toggleBold },
            { key: 'Mod-s', run: () => { callbacks.current.onSave(); return true } },
            ...historyKeymap, ...defaultKeymap,
          ]),
          EditorView.contentAttributes.of({ 'aria-label': '笔记正文', spellcheck: 'false' }),
          EditorView.updateListener.of(update => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString())
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: 'inherit' },
            '&.cm-focused': { outline: 'none' },
            '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit' },
            '.cm-content': { padding: '12px 16px 20px', caretColor: 'currentColor' },
            '.cm-line': { padding: '0' },
            '.pf-note-strong': { fontWeight: '700' },
            '.pf-note-emphasis': { fontStyle: 'italic' },
            '.pf-note-code': { fontFamily: 'monospace', backgroundColor: 'color-mix(in srgb, currentColor 10%, transparent)' },
          }),
        ],
      }),
    })
    editor.current = view
    return () => { editor.current = null; view.destroy() }
  }, [])

  return (
    <>
      <div className="note-toolbar" role="group" aria-label="Markdown 格式">
        <button type="button" className={noteToolClass} title="粗体 (Ctrl+B)" aria-label="粗体"
          onMouseDown={event => event.preventDefault()} onClick={() => {
            if (editor.current) { toggleBold(editor.current); editor.current.focus() }
          }}><Bold size={16} /></button>
        <button type="button" className={noteToolClass} title="无序列表" aria-label="无序列表"
          onMouseDown={event => event.preventDefault()} onClick={() => { if (editor.current) formatLines(editor.current, 'bullet') }}>
          <List size={17} />
        </button>
        <button type="button" className={noteToolClass} title="有序列表" aria-label="有序列表"
          onMouseDown={event => event.preventDefault()} onClick={() => { if (editor.current) formatLines(editor.current, 'ordered') }}>
          <ListOrdered size={17} />
        </button>
        <select value="" onChange={event => { if (editor.current) formatLines(editor.current, Number(event.target.value)) }}
          className="note-select"
          aria-label="标题等级" title="标题等级">
          <option value="" disabled>标题</option>
          <option value={0}>正文</option>
          {[1, 2, 3, 4, 5, 6].map(level => <option key={level} value={level}>H{level}</option>)}
        </select>
      </div>
      <div ref={host} className="note-prose" />
    </>
  )
}
