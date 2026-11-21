
import { createContext, lazy, Suspense, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { BookOpen, ChevronUp, Minus, NotebookPen, Settings, Sparkles, Star, X } from 'lucide-react'
import { useStore } from '../store'
import type { AppView } from '../types'
import AnalysisDialog from './AnalysisDialog'
const NotesPage = lazy(() => import('./notes/NotesPage'))
type Target = { articleId: number; title: string }
type Tab = 'note' | 'ai'
const WorkspaceContext = createContext<(tab: Tab, target: Target) => void>(() => {})
export const useWorkspace = () => useContext(WorkspaceContext)

export default function ReadingWorkspace({ view, children }: { view: AppView; children: ReactNode }) {
  const [tab, setTab] = useState<Tab>('note')
  const [opened, setOpened] = useState(false)
  const [note, setNote] = useState<Target>()
  const [ai, setAi] = useState<Target>()
  const [error, setError] = useState('')
  const busy = useRef(false)
  const state = useRef({ note, ai, tab, opened })
  state.current = { note, ai, tab, opened }
  const current = useStore(s => s.queue[s.currentIndex])
  const setView = useStore(s => s.setView)
  const reading = view === 'widget' || view === 'bookmarkDetail'

  async function open(next: Tab, target: Target) {
    if (busy.current) return
    busy.current = true
    setError('')
    try {
      await window.electronAPI.setWorkspaceExpanded(true)
      setOpened(true)
      if (next === 'note' && state.current.note?.articleId !== target.articleId) {
        await window.electronAPI.notes.open(target.articleId)
        setNote(target)
      }
      if (next === 'ai') setAi(target)
      setTab(next)
    } catch (e) { setError('无法打开面板：' + String(e)) }
    finally { busy.current = false }
  }
  async function close() {
    if (busy.current) return
    busy.current = true
    try {
      if (state.current.note) await window.electronAPI.notes.flush()
      await window.electronAPI.setWorkspaceExpanded(false)
      setOpened(false)
      setError('')
    } catch { setError('笔记尚未保存成功，请重试后关闭面板。') }
    finally { busy.current = false }
  }
  function switchTab(next: Tab) {
    const saved = next === 'note' ? note : ai
    if (saved) setTab(next)
    else if (current) void open(next, { articleId: current.articleId, title: current.titleCn || current.title })
  }
  useEffect(() => window.electronAPI.notes.onClosed(() => {
    setNote(undefined)
    if (state.current.tab === 'note') {
      if (state.current.ai) setTab('ai')
      else {
        void window.electronAPI.setWorkspaceExpanded(false).then(() => setOpened(false))
          .catch(() => setError('请展开窗口后再关闭面板'))
      }
    }
  }), [])

  const target = tab === 'note' ? note : ai
  return <WorkspaceContext.Provider value={(next, target) => void open(next, target)}>
    <div className="reading-workspace paper-ui" data-side={opened} data-reading={reading}>
      {reading && <header className="workspace-header paper-header drag-handle">
        <span className="paper-header-name"><BookOpen size={16} />PaperFeed</span>
        <div className="paper-window-controls no-drag">
          <button title="收藏列表" aria-label="收藏列表" onClick={() => setView('bookmarks')}><Star size={16} /></button>
          <button title="设置" aria-label="设置" onClick={() => setView('settings')}><Settings size={16} /></button>
          <button data-collapse title="收起 PaperFeed" aria-label="收起 PaperFeed"><ChevronUp size={17} /></button>
          <button title="最小化" aria-label="最小化" onClick={() => window.electronAPI.minimizeWindow()}><Minus size={16} /></button>
        </div>
      </header>}
      <div className="workspace-columns">
        <section className="workspace-reader">{children}</section>
        <aside className="workspace-side" hidden={!opened}>
          <div className="workspace-tabs">
            <button aria-pressed={tab === 'note'} onClick={() => switchTab('note')}><NotebookPen size={16} />笔记</button>
            <button aria-pressed={tab === 'ai'} onClick={() => switchTab('ai')}><Sparkles size={16} />AI 分析</button>
            <button className="workspace-close" title="关闭侧栏" aria-label="关闭侧栏" onClick={() => void close()}><X size={16} /></button>
          </div>
          {target && (!reading || target.articleId !== current?.articleId) &&
            <div className="workspace-context"><span>正在处理另一篇文章</span><p title={target.title}>{target.title}</p></div>}
          {error && <div className="workspace-error" role="alert">{error}</div>}
          <div className="workspace-tab-body" hidden={tab !== 'note'}>
            {note && <Suspense fallback={<p className="workspace-placeholder">正在打开笔记…</p>}>
              <NotesPage key={note.articleId} articleId={note.articleId} embedded />
            </Suspense>}
          </div>
          <div className="workspace-tab-body" hidden={tab !== 'ai'}>
            {ai && <AnalysisDialog key={ai.articleId} articleId={ai.articleId} articleTitle={ai.title} onClose={() => void close()} embedded />}
          </div>
        </aside>
      </div>
    </div>
  </WorkspaceContext.Provider>
}
