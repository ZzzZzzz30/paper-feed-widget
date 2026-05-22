import { useState, useCallback, useEffect, useRef } from 'react'
import { useStore } from '../store'
import ArticleCard from './ArticleCard'
import ActionBar from './ActionBar'
import type { PushQueueItem, InteractionAction, ActionBarKey } from '../types'

interface Props {
  item: PushQueueItem
  itemIndex: number
  hasMore: boolean
  mode?: 'push' | 'bookmarks'
}

export default function CardStack({ item, itemIndex, hasMore, mode = 'push' }: Props) {
  const advanceQueue = useStore(s => s.advanceQueue)
  const goBack = useStore(s => s.goBack)
  const advanceCircular = useStore(s => s.advanceCircular)
  const goBackCircular = useStore(s => s.goBackCircular)
  const setView = useStore(s => s.setView)
  const updateQueueItem = useStore(s => s.updateQueueItem)
  const removeFromQueue = useStore(s => s.removeFromQueue)
  const setCurrentArticleId = useStore(s => s.setCurrentArticleId)
  const [exitAnimation, setExitAnimation] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const itemRef = useRef(item)
  itemRef.current = item
  const rootRef = useRef<HTMLDivElement>(null)

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2000) }

  useEffect(() => {
    setExitAnimation(null)
    if (!item.abstract || !item.doi) {
      window.electronAPI.enrichArticle(item.articleId).then(result => {
        if (!result || itemRef.current.articleId !== item.articleId) return
        const updates: Partial<PushQueueItem> = {}
        if (result.abstract && !itemRef.current.abstract) updates.abstract = result.abstract
        if (result.extra_doi && !itemRef.current.doi) updates.doi = result.extra_doi
        if (Object.keys(updates).length > 0) updateQueueItem(itemIndex, updates)
      }).catch(() => {})
    }
  }, [item.articleId, item.abstract, item.doi])

  useEffect(() => {
    if (item.titleCn) return
    let stopped = false
    const check = async () => {
      if (stopped) return
      const result = await window.electronAPI.translateArticle(item.articleId)
      if (result && result.title_cn && itemRef.current.articleId === item.articleId) {
        updateQueueItem(itemIndex, { titleCn: result.title_cn, abstractCn: result.abstract_cn || '' })
        clearInterval(timer)
      }
    }
    check()
    const timer = setInterval(check, 5000)
    window.electronAPI.onArticleTranslated((data) => {
      const q = useStore.getState().queue
      const idx = q.findIndex(it => it.articleId === data.articleId)
      if (idx >= 0) useStore.getState().updateQueueItem(idx, { titleCn: data.titleCn, abstractCn: data.abstractCn || '' })
      if (!stopped && data.articleId === itemRef.current.articleId) clearInterval(timer)
    })
    window.electronAPI.onMetadataUpdated?.((data) => {
      const q = useStore.getState().queue
      const idx = q.findIndex(it => it.articleId === data.articleId)
      if (idx >= 0) useStore.getState().updateQueueItem(idx, { abstract: data.abstract || '', doi: data.doi || '' })
    })
    return () => { stopped = true; clearInterval(timer) }
  }, [item.articleId, item.titleCn])

  const handleRemoveBookmark = useCallback(async () => {
    if (isProcessing) return
    setIsProcessing(true)
    await window.electronAPI.removeBookmark(item.articleId)
    setExitAnimation('card-exit-bookmark')
    setTimeout(() => { advanceQueue(); setIsProcessing(false) }, 300)
  }, [item.articleId, isProcessing])

  const handleAction = useCallback(async (action: ActionBarKey) => {
    if (isProcessing) return
    if (action === 'analyze') return

    // 执行离开当前文章的操作前关闭 AI 面板
    window.electronAPI.closeAnalysisBubble?.()
    setIsProcessing(true)
    setCurrentArticleId(item.articleId)

    if (mode === 'bookmarks') {
      if (action === 'skip') { goBackCircular(); setIsProcessing(false); return }
      if (action === 'next') { advanceCircular(); setIsProcessing(false); return }
    }

    const animMap: Record<string, string> = {
      dislike: 'card-exit-dislike', skip: 'card-exit-dislike',
      bookmark: 'card-exit-bookmark',
    }
    setExitAnimation(animMap[action] || '')
    // next 不是交互，不需要记录
    if (action !== 'next') {
      await window.electronAPI.recordInteraction(item.articleId, action as InteractionAction)
    }

    // bookmark 和 dislike 都应从推送队列立即移除
    if (action === 'bookmark' || action === 'dislike') {
      removeFromQueue(item.articleId)
      setTimeout(() => { setIsProcessing(false) }, 300)
    } else {
      setTimeout(() => { advanceQueue(); setIsProcessing(false) }, 300)
    }
  }, [item.articleId, isProcessing, mode])

  return (
    <div ref={rootRef} className="relative z-0 w-full h-full flex flex-col items-center gap-2 overflow-hidden">
      {mode === 'bookmarks' && (
        <div className="no-drag w-full flex justify-between items-center px-1 shrink-0">
          <div className="flex gap-2">
            <button onClick={() => setView('bookmarks')} className="text-xs theme-text-muted hover:theme-text-secondary">← 返回列表</button>
            <button onClick={() => { useStore.getState().restorePushState(); setView('widget') }} className="text-xs theme-text-subtle hover:theme-text-secondary">返回推送</button>
          </div>
          <span className="text-xs theme-text-subtle">{itemIndex + 1}/{useStore.getState().queue.length}</span>
        </div>
      )}

      {toast && <div className="no-drag shrink-0 text-xs theme-text-secondary theme-bg-overlay-strong px-3 py-1 rounded-full animate-pulse">{toast}</div>}

      <div className={`w-full flex-1 min-h-0 ${exitAnimation || 'card-enter'}`}>
        <ArticleCard item={item} />
      </div>
      <div className="no-drag w-full shrink-0">
        <ActionBar onAction={handleAction} onRemoveBookmark={handleRemoveBookmark}
          onAnalyze={() => {
            window.electronAPI.openAnalysisBubble({ articleId: item.articleId, articleTitle: item.titleCn || item.title })
          }}
          disabled={isProcessing} mode={mode} />
      </div>
    </div>
  )
}
