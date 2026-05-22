import { useEffect } from 'react'
import { useStore } from './store'
import WidgetWindow from './components/WidgetWindow'
import BookmarkList from './components/BookmarkList'
import SettingsPanel from './components/SettingsPanel'
import AnalysisBubblePage from './components/AnalysisBubblePage'
import type { AppView } from './types'

export default function App() {
  // 独立气泡窗口路由
  if (window.location.hash.startsWith('#/analysis-bubble')) {
    return <AnalysisBubblePage />
  }
  const view = useStore(s => s.view)
  const setSettings = useStore(s => s.setSettings)

  const setView = useStore(s => s.setView)

  // 视图切换时关闭 AI 面板
  useEffect(() => { window.electronAPI.closeAnalysisBubble?.() }, [view])

  useEffect(() => {
    window.electronAPI?.getSettings().then(settings => {
      setSettings(settings)
      // 应用主题
      const theme = settings.theme || 'auto'
      if (['light','midnight','forest','rose','paper'].includes(theme)) {
        document.documentElement.setAttribute('data-theme', theme)
      } else {
        document.documentElement.removeAttribute('data-theme')
      }
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
    window.electronAPI?.onNavigate((view: string) => {
      setView(view as AppView)
    })
  }, [])

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
    <div className="w-full h-full bg-transparent">
      {renderView()}
    </div>
  )
}
