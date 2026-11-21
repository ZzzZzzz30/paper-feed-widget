import { useCallback, useEffect, useState } from 'react'

interface Conference {
  id: string
  name: string
  enabled: boolean
}

export default function ConferenceManager() {
  const [conferences, setConferences] = useState<Conference[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [message, setMessage] = useState('')
  const [errors, setErrors] = useState<string[]>([])

  const load = useCallback(async () => {
    try { setConferences(await window.electronAPI.getConferences()) }
    catch { setMessage('会议列表读取失败') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const toggle = async (id: string, enabled: boolean) => {
    const next = conferences.map(conference => conference.id === id ? { ...conference, enabled } : conference)
    setConferences(next)
    try { await window.electronAPI.saveConferences(next) }
    catch { setMessage('会议设置保存失败'); await load() }
  }

  const sync = async () => {
    setSyncing(true)
    setMessage('')
    setErrors([])
    try {
      const result = await window.electronAPI.syncConferences()
      setErrors(result.errors)
      setMessage(`${result.errors.length ? '同步结束，部分来源待重试' : '同步完成'}，新增 ${result.inserted} 篇`)
    } catch { setMessage('同步失败，将在后续定时任务重试') }
    finally { setSyncing(false) }
  }

  if (loading) return <div className="text-xs theme-text-muted">读取会议列表...</div>

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {conferences.map(conference => (
          <label key={conference.id} className="flex min-w-0 items-center gap-2 py-1 text-xs theme-text-secondary">
            <input type="checkbox" checked={conference.enabled} onChange={event => void toggle(conference.id, event.target.checked)} />
            <span className="truncate">{conference.name}</span>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => void sync()} disabled={syncing} className="no-drag px-2 py-1 text-xs rounded theme-bg-overlay theme-text-main disabled:opacity-50">
          {syncing ? '正在同步...' : '立即同步'}
        </button>
        {message && <span role="status" className="min-w-0 text-xs theme-text-muted">{message}</span>}
      </div>
      {errors.length > 0 && <details className="text-xs theme-text-muted">
        <summary>查看未完成的来源</summary>
        <ul className="mt-1 space-y-1 break-words">{errors.map(error => <li key={error}>{error}</li>)}</ul>
      </details>}
    </div>
  )
}
