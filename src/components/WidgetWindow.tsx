import { useEffect, useState } from 'react'
import { BookOpen, ChevronUp, Minus, Settings, Star } from 'lucide-react'
import { useStore } from '../store'
import CardStack from './CardStack'
import type { PushQueueItem, Article } from '../types'

interface Props {
  mode?: 'push' | 'bookmarks'
}

export default function WidgetWindow({ mode = 'push' }: Props) {
  const yearFrom = useStore(s => s.settings.year_from)
  const [loading, setLoading] = useState(true)
  const setQueue = useStore(s => s.setQueue)
  const restoreQueue = useStore(s => s.restoreQueue)
  const queue = useStore(s => s.queue)
  const currentIndex = useStore(s => s.currentIndex)
  const appendQueue = useStore(s => s.appendQueue)
  const setView = useStore(s => s.setView)

  // 每次索引或队列变化时保存推送位置
  useEffect(() => {
    if (mode !== 'push' || queue.length === 0) return
    const ids = queue.map(it => it.articleId)
    window.electronAPI.savePushState({ ids, index: currentIndex })
  }, [mode, queue, currentIndex])

  useEffect(() => {
    if (yearFrom === undefined) return
    if (mode === 'push') {
      const eligible = queue.filter(item => item.year >= Number(yearFrom))
      if (eligible.length !== queue.length) {
        const currentId = queue[currentIndex]?.articleId
        restoreQueue(eligible, Math.max(0, eligible.findIndex(item => item.articleId === currentId)))
      }
      if (eligible.length === 0) { void loadQueue(); return }
    } else if (queue.length === 0) { void loadQueue(); return }
    setLoading(false)
  }, [mode, yearFrom])

  useEffect(() => {
    if (mode !== 'push' || queue.length === 0 || loading) return
    const remaining = queue.length - currentIndex
    if (remaining <= 5) { loadMore() }
  }, [currentIndex, queue.length])

  const loadQueue = async () => {
    setLoading(true)
    try {
      if (mode === 'bookmarks') {
        const articles = await window.electronAPI.getArticles({ status: 'bookmarked', limit: 50 })
        const items: PushQueueItem[] = articles.map((a: Article) => ({
          articleId: a.id, title: a.title || '', titleCn: a.title_cn || '',
          abstract: a.abstract || '', abstractCn: a.abstract_cn || '',
          doi: a.extra_doi || '', url: a.pdf_url || a.url || '', tldr: '', innovation: [],
          journal: a.journal || '', year: a.year || 0, score: 0,
        }))
        setQueue(items)
      } else {
        // 尝试恢复上次退出时的位置
        const saved = await window.electronAPI.loadPushState()
        if (saved && saved.ids?.length > 0) {
          const blockedIds = await window.electronAPI.getBlockedPushIds()
          const blockedSet = new Set(blockedIds)
          const savedItems: PushQueueItem[] = []
          const articles = await window.electronAPI.getArticles({ limit: 500 })
          const articleMap = new Map(articles.map((a: Article) => [a.id, a]))
          for (const id of saved.ids) {
            if (blockedSet.has(id)) continue
            const a = articleMap.get(id)
            if (a) {
              savedItems.push({
                articleId: a.id, title: a.title || '', titleCn: a.title_cn || '',
                abstract: a.abstract || '', abstractCn: a.abstract_cn || '',
                doi: a.extra_doi || '', url: a.pdf_url || a.url || '', tldr: '', innovation: [],
                journal: a.journal || '', year: a.year || 0, score: 0,
              })
            }
          }
          if (savedItems.length > 0) {
            restoreQueue(savedItems, saved.index)
            console.log(`[Widget] 恢复上次位置: ${saved.index + 1}/${savedItems.length}`)
            setLoading(false)
            return
          }
        }
        const items = await window.electronAPI.requestNewPush()
        if (items.length > 0) console.log(`[Widget] 收到${items.length}篇`)
        const blockedIds = await window.electronAPI.getBlockedPushIds()
        const blockedSet = new Set(blockedIds)
        const filtered = items.filter(it => !blockedSet.has(it.articleId))
        if (filtered.length < items.length) console.log(`[Widget] 过滤掉 ${items.length - filtered.length} 篇`)
        setQueue(filtered)
      }
    } catch (err) { console.error('[Widget] 加载失败:', err) }
    setLoading(false)
  }

  const loadMore = async () => {
    try {
      const excludeIds = queue.map(item => item.articleId)
      const items = await window.electronAPI.requestMorePush?.(excludeIds)
      if (items && items.length > 0) {
        const blockedIds = await window.electronAPI.getBlockedPushIds()
        const blockedSet = new Set(blockedIds)
        const filtered = items.filter(it => !blockedSet.has(it.articleId))
        appendQueue(filtered)
      }
    } catch {}
  }

  const handleRefresh = async () => { await loadQueue() }

  const currentItem: PushQueueItem | undefined = queue[currentIndex]
  const hasMore = currentIndex < queue.length - 1
  const isFinished = queue.length > 0 && currentIndex >= queue.length

  return (
    <div className="app-shell">
      <div className="window-safe-area">
        <div className="window-frame theme-window paper-widget">
          {/* 标题栏 — 绝对定位，0–32px，仅负责拖拽和按钮 */}
          <div className="window-titlebar">
            <span className="paper-widget-name">
              {mode === 'bookmarks' ? <Star size={15} /> : <BookOpen size={15} />}
              {mode === 'bookmarks' ? '收藏详情' : 'PaperFeed'}
            </span>
            <div className="window-control paper-window-controls">
              <button type="button" onClick={() => setView('bookmarks')} title="收藏列表" aria-label="收藏列表"><Star size={16} /></button>
              <button type="button" onClick={() => setView('settings')} title="设置" aria-label="设置"><Settings size={16} /></button>
              {mode === 'push' && <button type="button" data-collapse title="收起 PaperFeed" aria-label="收起 PaperFeed"><ChevronUp size={17} /></button>}
              <button type="button" onClick={() => window.electronAPI.minimizeWindow()} title="最小化" aria-label="最小化"><Minus size={16} /></button>
            </div>
          </div>

          {/* 内容区 — 绝对定位，从 32px 开始，绝不进入标题栏 */}
          <div className="window-body">
            {loading ? (
              <div className="theme-text-muted text-sm animate-pulse">加载中...</div>
            ) : isFinished ? (
              <div className="text-center">
                <div className="theme-text-secondary text-lg mb-2">
                  {mode === 'bookmarks' ? '已浏览全部收藏' : '暂无更多可读文章'}
                </div>
                <button onClick={handleRefresh}
                  className="no-drag px-4 py-2 rounded-lg theme-bg-overlay-strong theme-text-secondary text-sm hover:theme-bg-hover transition-colors">
                  {mode === 'bookmarks' ? '刷新' : '刷新推送'}
                </button>
              </div>
            ) : queue.length === 0 ? (
              <div className="text-center">
                <div className="theme-text-secondary text-lg mb-2">
                  {mode === 'bookmarks' ? '暂无收藏文章' : '暂无推送文章'}
                </div>
                <button onClick={() => mode === 'bookmarks' ? setView('widget') : handleRefresh()}
                  className="no-drag px-4 py-2 rounded-lg theme-bg-overlay-strong theme-text-secondary text-sm hover:theme-bg-hover transition-colors">
                  {mode === 'bookmarks' ? '返回推送' : '重试'}
                </button>
              </div>
            ) : currentItem ? (
              <CardStack item={currentItem} itemIndex={currentIndex} hasMore={hasMore} mode={mode} />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
