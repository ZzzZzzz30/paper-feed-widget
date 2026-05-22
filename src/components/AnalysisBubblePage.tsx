import { useState, useEffect } from 'react'
import AnalysisDialog from './AnalysisDialog'

function getArticleIdFromLocation(): number | null {
  const hash = window.location.hash || ''
  const qi = hash.indexOf('?')
  if (qi >= 0) {
    const params = new URLSearchParams(hash.slice(qi + 1))
    const id = Number(params.get('articleId'))
    if (Number.isFinite(id) && id > 0) return id
  }
  const params = new URLSearchParams(window.location.search)
  const id = Number(params.get('articleId'))
  return Number.isFinite(id) && id > 0 ? id : null
}

export default function AnalysisBubblePage() {
  const [articleId, setArticleId] = useState<number | null>(null)

  useEffect(() => {
    const id = getArticleIdFromLocation()
    console.log('[AnalysisBubblePage] init articleId =', id, {
      href: window.location.href,
      search: window.location.search,
      hash: window.location.hash,
    })
    if (id) setArticleId(id)

    const unsub = window.electronAPI.onAnalysisBubbleUpdate?.((data: { articleId: number }) => {
      console.log('[AnalysisBubblePage] update articleId =', data.articleId)
      setArticleId(data.articleId)
    })

    window.electronAPI?.getSettings().then(settings => {
      const theme = settings.theme || 'auto'
      if (['light','midnight','forest','rose','paper'].includes(theme)) {
        document.documentElement.setAttribute('data-theme', theme)
      }
      const fs = settings.font_size
      if (fs) document.documentElement.style.setProperty('--app-font-size', fs + 'px')
      const ff = settings.font_family || 'system'
      const fontMap: Record<string, string> = {
        system: 'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
        sans: '"Noto Sans SC","Microsoft YaHei",system-ui,sans-serif',
        serif: '"Noto Serif SC","Source Han Serif SC",Georgia,serif',
        mono: '"JetBrains Mono",Consolas,monospace',
        rounded: '"Nunito","Segoe UI Rounded","Microsoft YaHei",sans-serif',
      }
      document.documentElement.style.setProperty('--app-font-family', fontMap[ff] || fontMap.system)
    })

    return () => {
      if (typeof unsub === 'function') unsub()
    }
  }, [])

  if (!articleId) return <div className="w-full h-full bg-transparent" />

  return (
    <div className="window-safe-area">
      <div className="w-full h-full theme-bubble-window">
        <AnalysisDialog key={articleId} articleId={articleId} articleTitle="" onClose={() => window.close()} showCloseButton={false} />
      </div>
    </div>
  )
}
