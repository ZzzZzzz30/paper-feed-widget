import { useEffect, useState } from 'react'
import type { AppDataInfo } from '../types'

export default function DataPanel() {
  const [info, setInfo] = useState<AppDataInfo | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    window.electronAPI.getAppDataInfo().then(info => { if (active) setInfo(info) })
      .catch(() => { if (active) setError('无法读取数据目录信息。') })
    return () => { active = false }
  }, [])

  async function openDirectory() {
    setError('')
    try { await window.electronAPI.openDataDirectory() }
    catch { setError('无法打开数据目录。') }
  }

  return (
    <div className="space-y-2 text-xs">
      {info && <div className="theme-text-secondary">当前版本：{info.currentVersion}</div>}
      <div className="space-y-1">
        <div className="theme-text-muted">期刊、文章、收藏和对话保存在用户数据目录；更新或重装应用不会清除此目录。</div>
        {info && <div className="text-[10px] theme-text-subtle break-all">{info.dataDirectory}</div>}
        <button type="button" className="theme-text-secondary underline" onClick={() => void openDirectory()}>打开数据目录</button>
      </div>
      {error && <div role="alert" className="text-red-400">{error}</div>}
    </div>
  )
}
