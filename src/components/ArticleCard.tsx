import type { PushQueueItem } from '../types'

interface Props {
  item: PushQueueItem
}

export default function ArticleCard({ item }: Props) {
  return (
    <div className="theme-inner-panel h-full min-h-0 overflow-hidden">
      <div data-article-scroll className="h-full min-h-0 overflow-y-auto p-5 flex flex-col gap-3 selectable-text">
        {/* 期刊 + 年份标签 */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs theme-text-secondary font-medium tracking-wide">
            {item.journal}
          </span>
          <span className="text-xs px-2 py-0.5 rounded-full theme-bg-overlay-strong theme-text-muted">
            {item.year}
          </span>
        </div>

        {/* 英文标题 */}
        <h2 className="text-sm font-semibold theme-text-main leading-relaxed shrink-0">
          {item.title}
        </h2>

        {/* 中文标题 */}
        {item.titleCn ? (
          <h3 className="text-sm font-medium theme-accent-text-soft leading-relaxed shrink-0">
            {item.titleCn}
          </h3>
        ) : null}

        {/* 分割线 */}
        <div className="border-t theme-border-light shrink-0" />

        {/* 摘要（中文优先，英文兜底） */}
        {item.abstractCn ? (
          <p className="text-xs theme-text-secondary leading-relaxed">
            {item.abstractCn}
          </p>
        ) : item.abstract ? (
          <p className="text-xs theme-text-muted leading-relaxed">
            {item.abstract}
          </p>
        ) : (
          <p className="text-xs theme-text-subtle italic shrink-0">摘要获取中...</p>
        )}

        {/* DOI 链接 */}
        <div className="shrink-0 mt-1 px-3 py-2 rounded-lg theme-bg-overlay theme-border-light border">
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
              className="no-drag text-[10px] theme-text-secondary hover:theme-text-main break-all transition-colors text-left cursor-pointer"
            >
              https://doi.org/{item.doi}
            </button>
          ) : (
            <span className="text-[10px] theme-text-subtle italic">DOI 获取中...</span>
          )}
        </div>
      </div>
    </div>
  )
}
