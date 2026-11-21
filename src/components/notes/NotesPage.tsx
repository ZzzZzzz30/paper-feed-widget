import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react'
import { BookOpen, Check, Ellipsis, NotebookPen, Pencil, Trash2, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import type { ArticleNote } from '../../types'
import NoteEditor, { noteToolClass } from './NoteEditor'
import './notes.css'
import WindowHeader from '../WindowHeader'
import { useStore } from '../../store'

const actionClass = 'note-action'
const EmbeddedNote = createContext(false)
const NoteArticleId = createContext<number | undefined>(undefined)


const NOTE_SIZES = [14, 16, 18, 20, 22, 24, 26, 28, 30, 32]
function noteSize(value?: string) {
  const size = Number(value)
  return NOTE_SIZES.includes(size) ? size : 22
}

function NoteFontSize() {
  const size = useStore(s => noteSize(s.settings.note_font_size))
  const updateSetting = useStore(s => s.updateSetting)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  return <span className="note-font-control">
    <label title="笔记字号（编辑和阅读模式共用）">
      <span aria-hidden="true">Aa</span>
      <select aria-label="笔记字号" value={size} disabled={saving}
        onChange={async event => {
          const value = event.target.value
          setSaving(true)
          setError('')
          try {
            await window.electronAPI.updateSetting('note_font_size', value)
            updateSetting('note_font_size', value)
          } catch { setError('字号保存失败，请重试') }
          finally { setSaving(false) }
        }}>
        {NOTE_SIZES.map(value => <option key={value} value={value}>{value}</option>)}
      </select>
    </label>
    {error && <span className="note-font-error" role="alert">{error}</span>}
  </span>
}

function NoteHeader({ children }: { children?: ReactNode }) {
  const articleId = useContext(NoteArticleId)
  const embedded = useContext(EmbeddedNote)
  if (embedded) return <div className="note-inline-controls"><span>Markdown</span><div className="note-header-controls"><NoteFontSize />{children}</div></div>
  return (
    <WindowHeader icon={<NotebookPen size={16} />} title="文章笔记">
      <div className="note-header-controls no-drag">
        <NoteFontSize />{children}
        <button type="button" className={noteToolClass} aria-label="关闭笔记" title="关闭笔记"
          onClick={() => void window.electronAPI.notes.close(articleId)}><X size={16} /></button>
      </div>
    </WindowHeader>
  )
}

function NoteDetail({ note }: { note: ArticleNote }) {
  const articleId = useContext(NoteArticleId)
  const embedded = useContext(EmbeddedNote)
  const [reading, setReading] = useState(false)
  const [more, setMore] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error'>('saved')
  const [actionError, setActionError] = useState('')
  const [hasContent, setHasContent] = useState(!!note.body.trim())
  const draft = useRef(note.body)
  const sequence = useRef(0)
  const pending = useRef<Promise<unknown>>(Promise.resolve())
  const moreButton = useRef<HTMLButtonElement>(null)
  const api = window.electronAPI.notes

  useEffect(() => {
    return api.onSaveStatus(status => {
      if (status.revision === sequence.current && (articleId === undefined || status.articleId === articleId)) {
        setSaveStatus(status.saved ? 'saved' : 'error')
      }
    })
  }, [api])

  function stage() {
    const revision = ++sequence.current
    setSaveStatus('saving')
    const request = api.stage(draft.current, revision, articleId)
    pending.current = request
    void request.catch(() => {
      if (sequence.current === revision) setSaveStatus('error')
    })
  }

  async function save() {
    const revision = sequence.current
    try {
      await pending.current
      await api.flush(articleId)
      if (sequence.current === revision) setSaveStatus('saved')
      return true
    } catch {
      if (sequence.current === revision) setSaveStatus('error')
      return false
    }
  }

  async function deleteNote() {
    setBusy(true)
    setActionError('')
    try {
      await api.remove(articleId)
    } catch {
      setActionError('无法删除笔记。')
      setBusy(false)
    }
  }

  return (
    <>
      <NoteHeader>
        <button type="button" className={noteToolClass} aria-label={reading ? '编辑' : '阅读模式'}
          title={reading ? '编辑' : '阅读模式'} data-active={reading}
          disabled={busy} onClick={() => setReading(value => !value)}>
          {reading ? <Pencil size={16} /> : <BookOpen size={16} />}
        </button>
        <div className="relative"
          onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setMore(false) }}
          onKeyDown={event => {
            if (event.key === 'Escape' && more) { setMore(false); moreButton.current?.focus() }
          }}>
          <button ref={moreButton} type="button" className={noteToolClass} title="更多操作" aria-label="更多操作"
            aria-expanded={more} disabled={busy || !hasContent} onClick={() => setMore(value => !value)}>
            <Ellipsis size={17} />
          </button>
          {more && (
            <div className="note-menu">
              <button type="button" className={actionClass + ' note-danger'} onClick={() => {
                setMore(false)
                setConfirmDelete(true)
              }}><Trash2 size={14} /> 删除笔记</button>
            </div>
          )}
        </div>
      </NoteHeader>
      {!embedded && <div className="note-title"><span className="note-context-label">当前文章</span><h1 title={note.title}>{note.title}</h1></div>}

      {confirmDelete && (
        <div className="note-confirm" role="group" aria-label="确认删除">
          <span className="mr-auto">永久删除这篇笔记？</span>
          <button type="button" className={actionClass} disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button>
          <button type="button" className={actionClass + ' note-danger'}
            disabled={busy} onClick={() => void deleteNote()}>删除</button>
        </div>
      )}
      {actionError && <p role="alert" className="note-message note-danger">{actionError}</p>}

      {reading && (
          <article className="note-prose note-preview">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}
              components={{
                a: ({ href, children }) => href && /^https?:\/\//i.test(href)
                  ? <a href={href} onClick={event => { event.preventDefault(); void window.electronAPI.openExternalUrl(href).catch(() => {}) }}>{children}</a>
                  : <span>{children}</span>,
                img: ({ alt }) => <span>{alt}</span>,
              }}>{draft.current}</ReactMarkdown>
          </article>
      )}
      <div className={reading ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
        <NoteEditor body={note.body}
          onChange={body => { draft.current = body; setHasContent(!!body.trim()); stage() }}
          onSave={() => { void save() }} />
      </div>

      <div className="note-status" role="status">
        {saveStatus === 'error' ? (
          <><span className="note-danger">保存失败</span>
            <button type="button" className={actionClass} onClick={() => { stage(); void save() }}>重试</button></>
        ) : saveStatus === 'saving' ? '保存中…' : hasContent ? (
          <><Check size={13} aria-hidden="true" /> 已保存</>
        ) : null}
      </div>
    </>
  )
}

export default function NotesPage({ embedded = false, articleId }: { embedded?: boolean; articleId?: number }) {
  const fontSize = useStore(s => noteSize(s.settings.note_font_size))
  const [note, setNote] = useState<ArticleNote | null>(null)
  const [error, setError] = useState(false)
  const api = window.electronAPI.notes

  function load() {
    setError(false)
    void api.read(articleId).then(setNote, () => setError(true))
  }

  useEffect(load, [api, articleId])

  return (
    <EmbeddedNote.Provider value={embedded}><NoteArticleId.Provider value={articleId}><main className="note-window paper-ui" style={{ '--note-font-size': fontSize + 'px' } as CSSProperties}>
      {note ? <NoteDetail note={note} /> : (
        <>
          <NoteHeader />
          {error ? (
            <div role="alert" className="note-message">
              无法读取文章笔记。<button type="button" onClick={load} className={actionClass}>重试</button>
            </div>
          ) : <p role="status" className="note-message">正在加载笔记…</p>}
        </>
      )}
    </main></NoteArticleId.Provider></EmbeddedNote.Provider>
  )
}
