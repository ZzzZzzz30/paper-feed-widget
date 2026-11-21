import { lazy, Suspense, useEffect } from 'react'
import { useStore } from './store'
import WidgetWindow from './components/WidgetWindow'
import BookmarkList from './components/BookmarkList'
import SettingsPanel from './components/SettingsPanel'
import AnalysisBubblePage from './components/AnalysisBubblePage'
import DesktopPanel from './components/DesktopPanel'
import ReadingWorkspace from './components/ReadingWorkspace'
import { applyAppearance, getAppearance } from './styles/appearance'
import type { AppView } from './types'

const NotesPage = lazy(() => import('./components/notes/NotesPage'))

export default function App() {
  // 独立气泡窗口路由
  if (window.location.hash.startsWith('#/analysis-bubble')) {
    return <AnalysisBubblePage />
  }
  return <WidgetApp articleNote={window.location.hash === '#/article-note'} />
}

function WidgetApp({ articleNote }: { articleNote: boolean }) {
  const view = useStore(s => s.view)
  const setSettings = useStore(s => s.setSettings)

  const setView = useStore(s => s.setView)
  const appearance = useStore(s => getAppearance(s.settings))
  useEffect(() => {
    applyAppearance(appearance)
    if (!articleNote) void window.electronAPI.setWindowMaterial(appearance.material).catch(console.error)
  }, [appearance, articleNote])

  // 视图切换时关闭 AI 面板
  useEffect(() => { if (!articleNote) window.electronAPI.closeAnalysisBubble?.() }, [view, articleNote])

  useEffect(() => {
    window.electronAPI?.getSettings().then(settings => {
      setSettings(settings)
      applyAppearance(getAppearance(settings))
      // 应用字体大小
      const fs = settings.font_size
      if (fs) {
        const fontSize = String(fs).replace('px', '')
        document.documentElement.style.setProperty('--app-font-size', fontSize + 'px')
        document.documentElement.style.fontSize = fontSize + 'px'
        console.log('[App] 应用字体大小:', fontSize + 'px')
      } else {
        console.log('[App] 未保存字体大小，使用默认值')
      }
      // 应用字体族
      const ff = settings.font_family || 'system'
      document.documentElement.dataset.font = ff
      const fontMap: Record<string, string> = {
        system: 'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
        sans: '"Noto Sans SC","Microsoft YaHei",system-ui,sans-serif',
        serif: '"Noto Serif SC","Source Han Serif SC",Georgia,serif',
        mono: '"JetBrains Mono",Consolas,monospace',
        rounded: '"Nunito","Segoe UI Rounded","Microsoft YaHei",sans-serif',
      }
      document.documentElement.style.setProperty('--app-font-family', fontMap[ff] || fontMap.system)
    })
    // 监听托盘导航
    if (!articleNote) window.electronAPI?.onNavigate((view: string) => {
      setView(view as AppView)
    })
  }, [articleNote])

  if (articleNote) {
    return <Suspense fallback={<div role="status" className="theme-text-main p-4">正在加载笔记…</div>}><NotesPage /></Suspense>
  }

  // 视图路由
  const renderView = () => {
    const views: Record<AppView, JSX.Element> = {
      widget: <WidgetWindow />,
      bookmarkDetail: <WidgetWindow mode="bookmarks" />,
      settings: <SettingsPanel />,
      bookmarks: <BookmarkList />,
    }
    return views[view] || <WidgetWindow />
  }

  return (
    <DesktopPanel view={view}>
      <ReadingWorkspace view={view}>{renderView()}</ReadingWorkspace>
    </DesktopPanel>
  )
}
