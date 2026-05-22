import { useEffect, useState, useMemo } from 'react'
import { useStore } from '../store'
import type { Article } from '../types'

export default function BookmarkList() {
  const setView = useStore(s => s.setView)
  const setQueue = useStore(s => s.setQueue)
  const setCurrentIndex = useStore(s => s.setCurrentIndex)
  const restorePushState = useStore(s => s.restorePushState)
  const bookmarkReadIds = useStore(s => s.bookmarkReadIds)
  const setBookmarkReadIds = useStore(s => s.setBookmarkReadIds)
  const toggleBookmarkRead = useStore(s => s.toggleBookmarkRead)
  const [articles, setArticles] = useState<Article[]>([])
  const [loading, setLoading] = useState(true)
  const [filterMode, setFilterMode] = useState<'all' | 'unread' | 'read'>('all')

  useEffect(() => {
    loadBookmarks()
    window.electronAPI.getReadArticleIds().then(ids => setBookmarkReadIds(ids || [])).catch(() => {})
  }, [])

  const loadBookmarks = async () => {
    setLoading(true)
    try {
      const list = await window.electronAPI.getArticles({ status: 'bookmarked', limit: 200 })
      const seen = new Set<number>()
      setArticles(list.filter((a: Article) => {
        if (seen.has(a.id)) return false
        seen.add(a.id)
        return true
      }))
    } catch {}
    setLoading(false)
  }

  const displayed = useMemo(() => {
    let result = [...articles]
    if (filterMode === 'unread') {
      result = result.filter(a => !bookmarkReadIds.has(a.id))
    } else if (filterMode === 'read') {
      result = result.filter(a => bookmarkReadIds.has(a.id))
    }
    return result
  }, [articles, filterMode, bookmarkReadIds])

  const handleOpenArticle = (article: Article) => {
    const items = displayed.map(a => ({
      articleId: a.id,
      title: a.title || '',
      titleCn: a.title_cn || '',
      abstract: a.abstract || '',
      abstractCn: a.abstract_cn || '',
      doi: a.extra_doi || '',
      tldr: '',
      innovation: [] as string[],
      journal: a.journal || '',
      year: a.year || 0,
      score: 0,
    }))
    const idx = displayed.findIndex(a => a.id === article.id)
    setQueue(items)
    setCurrentIndex(idx >= 0 ? idx : 0)
    setView('bookmarkDetail')
  }

  const handleBackToPush = () => {
    restorePushState()
    setView('widget')
  }

  const filterBtn = (mode: 'all' | 'unread' | 'read', label: string) => (
    <button
      onClick={() => setFilterMode(mode)}
      className={`no-drag text-[11px] px-2 py-0.5 rounded border transition-colors ${
        filterMode === mode
          ? 'theme-accent-bg theme-accent-text theme-accent-border'
          : 'theme-bg-overlay theme-text-muted theme-border-light'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="window-safe-area">
      <div className="window-frame theme-window">
        <div className="window-titlebar bookmark-titlebar">
          <span className="text-sm theme-text-secondary font-medium">⭐ 收藏列表</span>
          <div className="window-control flex items-center gap-2">
            {filterBtn('all', '全部')}
            {filterBtn('unread', '未读')}
            {filterBtn('read', '已读')}
            <button onClick={handleBackToPush}
              className="text-xs theme-text-muted hover:theme-text-secondary transition-colors ml-1">
              ← 返回推送
            </button>
          </div>
        </div>

        <div className="window-body bookmark-window-body">
          <div className="w-full h-full min-h-0 overflow-y-auto">
        {loading ? (
          <div className="p-8 text-center theme-text-muted text-sm">加载中...</div>
        ) : displayed.length === 0 ? (
          <div className="p-8 text-center">
            <div className="theme-text-secondary text-sm mb-3">
              {filterMode === 'unread' ? '所有收藏已读' : filterMode === 'read' ? '无已读文章' : '暂无收藏文章'}
            </div>
            <button onClick={handleBackToPush}
              className="no-drag px-4 py-2 rounded-lg theme-bg-overlay-strong theme-text-secondary text-sm hover:theme-bg-hover transition-colors">
              返回推送
            </button>
          </div>
        ) : (
          displayed.map((article) => {
            const isRead = bookmarkReadIds.has(article.id)
            return (
              <div
                key={article.id}
                role="button"
                tabIndex={0}
                onClick={() => handleOpenArticle(article)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleOpenArticle(article) }}
                className={`w-full text-left px-4 py-3 border-b theme-border-light
                  hover:theme-bg-overlay transition-colors space-y-1 cursor-pointer ${isRead ? 'opacity-50' : ''}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[11px] theme-text-muted">{article.journal}</span>
                  <span className="text-[11px] px-1.5 py-0.5 rounded-full theme-bg-overlay-strong theme-text-subtle">
                    {article.year}
                  </span>
                  {!isRead && <span className="text-[10px] theme-accent-text-soft">● 未读</span>}
                </div>
                <p className={`text-xs leading-relaxed line-clamp-2 ${isRead ? 'theme-text-muted' : 'theme-text-main'}`}>
                  {article.title_cn || article.title}
                </p>
                <p className={`text-[11px] leading-relaxed line-clamp-2 ${isRead ? 'theme-text-subtle' : 'theme-text-muted'}`}>
                  {article.abstract_cn || '中文摘要生成中...'}
                </p>
                <div className="flex items-center gap-2">
                  {article.extra_doi ? (
                    <p className="text-[10px] theme-accent-text-soft truncate">{article.extra_doi}</p>
                  ) : null}
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleBookmarkRead(article.id) }}
                    className="no-drag text-[10px] theme-text-subtle hover:theme-text-secondary ml-auto"
                  >
                    {isRead ? '标记未读' : '标记已读'}
                  </button>
                </div>
              </div>
            )
          })
        )}
          </div>
        </div>
      </div>
    </div>
  )
}
