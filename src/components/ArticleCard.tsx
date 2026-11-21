import type { PushQueueItem } from '../types'

interface Props {
  item: PushQueueItem
}

export default function ArticleCard({ item }: Props) {
  return (
    <div className="paper-article h-full min-h-0 overflow-hidden">
      <div data-article-scroll className="paper-article-scroll selectable-text">
        {/* 期刊 + 年份标签 */}
        <div className="paper-article-meta">
          <span className="paper-source">
            {item.journal}
          </span>
          <span className="paper-year">
            {item.year}
          </span>
        </div>

        {/* 英文标题 */}
        <h2 className="paper-article-title">
          {item.title}
        </h2>

        {/* 中文标题 */}
        {item.titleCn ? (
          <h3 className="paper-article-translation">
            {item.titleCn}
          </h3>
        ) : null}

        {/* 分割线 */}
        <div className="paper-article-divider" />

        {/* 摘要（中文优先，英文兜底） */}
        {item.abstractCn ? (
          <p className="paper-article-abstract">
            {item.abstractCn}
          </p>
        ) : item.abstract ? (
          <p className="paper-article-abstract">
            {item.abstract}
          </p>
        ) : (
          <p className="paper-article-abstract theme-text-muted">摘要获取中...</p>
        )}

        {/* DOI 或论文原文 */}
        <div className="paper-article-link">
          {item.doi ? (
            <button
              type="button"
              onClick={async (e) => {
                e.preventDefault()
                e.stopPropagation()
                const doi = item.doi?.trim()
                if (!doi) return
                const url = doi.startsWith('http') ? doi : `https://doi.org/${doi}`
                console.log('[DOI] clicked:', url)
                if (!window.electronAPI?.openExternalUrl) {
                  console.error('[DOI] openExternalUrl is not available')
                  return
                }
                try { await window.electronAPI.openExternalUrl(url) }
                catch (err) { console.error('[DOI] open failed:', err) }
              }}
              className="no-drag paper-original"
            >
              https://doi.org/{item.doi}
            </button>
          ) : item.url ? (
            <button type="button" onClick={async event => {
              event.preventDefault()
              event.stopPropagation()
              try { await window.electronAPI.openExternalUrl(item.url || '') }
              catch (error) { console.error('[Paper] open failed:', error) }
            }} className="no-drag paper-original">
              查看论文原文
            </button>
          ) : (
            <span className="theme-text-muted">DOI 获取中...</span>
          )}
        </div>
      </div>
    </div>
  )
}
