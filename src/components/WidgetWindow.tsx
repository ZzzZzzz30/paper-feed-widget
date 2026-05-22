import { useEffect, useState } from 'react'
import { useStore } from '../store'
import CardStack from './CardStack'
import type { PushQueueItem, Article } from '../types'

interface Props {
  mode?: 'push' | 'bookmarks'
}

export default function WidgetWindow({ mode = 'push' }: Props) {
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
    if (queue.length === 0) { loadQueue() }
    else { setLoading(false) }
  }, [mode])

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
          doi: a.extra_doi || '', tldr: '', innovation: [],
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
                doi: a.extra_doi || '', tldr: '', innovation: [],
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
        <div className="window-frame theme-window">
          {/* 标题栏 — 绝对定位，0–32px，仅负责拖拽和按钮 */}
          <div className="window-titlebar">
            <span className="text-xs theme-text-muted font-medium">
              {mode === 'bookmarks' ? '⭐ 收藏列表' : 'PaperFeed'}
            </span>
            <div className="window-control flex items-center gap-3">
              <button onClick={() => window.electronAPI.minimizeWindow()}
                className="w-5 h-5 flex items-center justify-center theme-text-muted hover:theme-text-secondary transition-colors" title="最小化">
                <span className="block w-2.5 h-[1.5px] bg-current rounded-full" />
              </button>
              <button onClick={() => setView('bookmarks')}
                className="w-5 h-5 flex items-center justify-center theme-text-muted hover:theme-text-secondary text-xs transition-colors">⭐</button>
              <button onClick={() => setView('settings')}
                className="w-5 h-5 flex items-center justify-center theme-text-muted hover:theme-text-secondary text-xs transition-colors">⚙️</button>
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
