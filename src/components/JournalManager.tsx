import { useEffect, useRef, useState } from 'react'
import type { JournalConfig, JournalCandidate } from '../types'

export default function JournalManager() {
  const [journals, setJournals] = useState<JournalConfig[]>([])
  const [loaded, setLoaded] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [candidates, setCandidates] = useState<JournalCandidate[]>([])
  const pending = useRef(false)

  useEffect(() => {
    window.electronAPI.getJournals().then(setJournals)
      .catch(() => setError('期刊列表读取失败，请重新打开设置'))
      .finally(() => setLoaded(true))
  }, [])

  const run = async (action: () => Promise<void>) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try { await action() }
    catch (err) { setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '操作失败，请重试') }
    finally { pending.current = false; setBusy(false) }
  }

  const addCandidate = async (journal: JournalCandidate) => {
    const result = await window.electronAPI.addJournal(journal)
    setJournals(result.journals)
    setCandidates([])
    setNewName('')
    setMessage(result.added ? `已添加「${journal.name}」，点击刷新推送即可抓取。` : `「${journal.name}」已在列表中。`)
  }

  const discover = () => run(async () => {
    const query = newName.trim()
    if (!query) return
    setCandidates([])
    const result = await window.electronAPI.discoverJournal(query)
    if (result.exact && result.candidates.length === 1) await addCandidate(result.candidates[0])
    else {
      setCandidates(result.candidates)
      setMessage('找到以下期刊，请选择要添加的一项：')
    }
  })

  const remove = (index: number) => run(async () => {
    if (!confirm(`确定移除「${journals[index].name}」？`)) return
    const updated = journals.filter((_, i) => i !== index)
    await window.electronAPI.saveJournals(updated)
    setJournals(updated)
  })

  const inputClass = 'min-w-0 flex-1 px-2 py-1.5 rounded text-xs theme-bg-overlay-strong theme-text-secondary border theme-border-light outline-none'
  if (!loaded) return <div className="text-xs theme-text-subtle">加载中...</div>

  return (
    <div className="space-y-2">
      {journals.length === 0 && <div className="text-xs theme-text-subtle">尚未订阅期刊，请输入名称添加。</div>}
      {journals.map((journal, index) => (
        <div key={journal.issn} className="flex items-center gap-1 text-xs">
          <span className="min-w-0 flex-1 theme-text-secondary truncate" title={journal.name}>{journal.name}</span>
          <span className="text-[10px] theme-text-subtle shrink-0">{journal.issn}</span>
          <button onClick={() => void remove(index)} disabled={busy} aria-label={`移除${journal.name}`} className="text-[10px] px-1 py-0.5 rounded text-red-400 disabled:opacity-50">✕</button>
        </div>
      ))}
      <form onSubmit={event => { event.preventDefault(); void discover() }} className="flex gap-1 pt-2 border-t theme-border-light">
        <input aria-label="期刊名称" placeholder="输入期刊名称，如 Cities" maxLength={200} value={newName} disabled={busy}
          onChange={event => { setNewName(event.target.value); setCandidates([]); setError(''); setMessage('') }} className={inputClass} />
        <button type="submit" disabled={!newName.trim() || busy} className="shrink-0 px-2 py-1 rounded text-[10px] theme-accent-bg theme-accent-text hover:opacity-80 disabled:opacity-50">
          {busy ? '处理中…' : '智能添加'}
        </button>
      </form>
      {error && <div role="alert" className="text-[10px] text-red-400 break-words">{error}</div>}
      {message && <div role="status" className="text-[10px] theme-text-secondary break-words">{message}</div>}
      {candidates.map(candidate => (
        <button key={candidate.issn} disabled={busy} onClick={() => void run(() => addCandidate(candidate))}
          className="block w-full text-left p-2 rounded border theme-border-light theme-bg-overlay disabled:opacity-50">
          <div className="text-xs theme-text-secondary break-words">{candidate.name}</div>
          <div className="text-[10px] theme-text-subtle break-words">{candidate.publisher} · ISSN {candidate.issn}</div>
        </button>
      ))}
      <div className="text-[10px] theme-text-subtle">自动查询真实期刊目录并填写 ISSN。英文全名可直接添加；中文名或缩写可使用已配置的 DeepSeek 辅助识别。多个匹配时请选择正确期刊。</div>
    </div>
  )
}
