import { createContext, useContext, useState, useEffect } from 'react'
import { BookOpen, Database, KeyRound, Languages, Library, Settings2 } from 'lucide-react'
import WindowHeader from './WindowHeader'
import { broadcastAppearance } from '../styles/theme-channel'
import { APPEARANCES, getAppearance } from '../styles/appearance'

const SettingsTab = createContext('reading')
const TABS = [
  { id: 'reading', label: '阅读', icon: BookOpen },
  { id: 'sources', label: '订阅', icon: Library },
  { id: 'translation', label: '翻译', icon: Languages },
  { id: 'keys', label: '密钥', icon: KeyRound },
  { id: 'data', label: '数据', icon: Database },
]
import { useStore } from '../store'
import JournalManager from './JournalManager'
import DataPanel from './DataPanel'
import ConferenceManager from './ConferenceManager'

const FONTS = [
  { key: 'system', name: '系统默认' },
  { key: 'sans', name: '现代无衬线' },
  { key: 'serif', name: '中文衬线' },
  { key: 'mono', name: '等宽字体' },
  { key: 'rounded', name: '圆体' },
]

export default function SettingsPanel() {
  const settings = useStore(s => s.settings)
  const setView = useStore(s => s.setView)
  const previousView = useStore(s => s.previousView)
  const updateSetting = useStore(s => s.updateSetting)
  const [tab, setTab] = useState('reading')
  const [appearanceBusy, setAppearanceBusy] = useState(false)
  const [appearanceError, setAppearanceError] = useState('')
  const [local, setLocal] = useState<Record<string, string>>({})

  useEffect(() => { setLocal({ ...settings }) }, [settings])

  const set = async (k: string, v: string) => {
    let value = v
    if ((k === 'font_size') && value.endsWith('px')) value = value.replace('px', '')
    setLocal(p => ({ ...p, [k]: value }))
    try {
      await window.electronAPI.updateSetting(k, value)
    } catch (err) {
      console.error(`[SettingsPanel] updateSetting ${k} 失败:`, err)
    }
    updateSetting(k, value)
    if (k === 'font_size') {
      document.documentElement.style.setProperty('--app-font-size', value + 'px')
      document.documentElement.style.fontSize = value + 'px'
    }
    if (k === 'font_family') {
      document.documentElement.dataset.font = value
      const fm: Record<string, string> = {
        system: 'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
        sans: '"Noto Sans SC","Microsoft YaHei",system-ui,sans-serif',
        serif: '"Noto Serif SC","Source Han Serif SC",Georgia,serif',
        mono: '"JetBrains Mono",Consolas,monospace',
        rounded: '"Nunito","Segoe UI Rounded","Microsoft YaHei",sans-serif',
      }
      document.documentElement.style.setProperty('--app-font-family', fm[value] || fm.system)
    }
  }

  const inp = "w-44 px-2 py-1 rounded-lg theme-bg-overlay-strong theme-text-secondary text-sm border theme-border outline-none focus:theme-accent-border"

  return (
    <div className="window-safe-area">
      <div className="w-full h-full theme-window paper-settings paper-ui flex flex-col">
      <WindowHeader icon={<Settings2 size={16} />} title="设置" onClose={() => setView(previousView)} />
      <nav className="paper-settings-tabs" aria-label="设置分类">
        {TABS.map(({ id, label, icon: Icon }) => <button key={id} type="button"
          aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
          <Icon size={16} /><span>{label}</span>
        </button>)}
      </nav>
      <SettingsTab.Provider value={tab}>
      <div className="paper-settings-body">
        <Section title="数据" group="data">
          <DataPanel />
        </Section>

        <Section title="API 密钥" group="keys">
          <div className="text-xs theme-text-subtle">密钥由系统加密保存。已保存的值不回传界面，输入新值后点击保存。</div>
          <SecretSetting label="Elsevier" settingKey="elsevier_api_key" placeholder="ScienceDirect API Key" />
          <SecretSetting label="阿里云 AK ID" settingKey="aliyun_access_key_id" placeholder="LTAI..." />
          <SecretSetting label="阿里云 AK Secret" settingKey="aliyun_access_key_secret" placeholder="Secret" />
          <SecretSetting label="DeepSeek" settingKey="deepseek_api_key" placeholder="sk-..." />
        </Section>

        <Section title="推送" group="reading">
          <PublicationYear />
          <Row label="每轮篇数"><input type="number" value={local.push_count || '20'} onChange={e => set('push_count', e.target.value)} min="5" max="100" className={inp + ' w-20'} /></Row>
          <PushKeywords />
        </Section>

        <Section title="文章统计" group="reading">
          <ArticleStatistics />
        </Section>

        <Section title="期刊管理" group="sources">
          <JournalManager />
        </Section>

        <Section title="会议管理" group="sources">
          <ConferenceManager />
        </Section>

        <Section title="翻译额度与安全" group="translation">
          <Row label="引擎"><select value={local.translation_provider || 'aliyun'} onChange={e => set('translation_provider', e.target.value)} className={inp + ' w-24'}><option value="aliyun">阿里云</option><option value="ollama">Ollama</option></select></Row>
          <Row label="失败时自动降级">
            <select value={local.allow_translation_fallback || 'false'} onChange={e => set('allow_translation_fallback', e.target.value)} className={inp + ' w-20'}>
              <option value="true">允许</option><option value="false">禁止</option>
            </select>
          </Row>
          <QuotaDashboard />
        </Section>

        <Section title="外观" group="reading">
          <div className="appearance-heading">外观方案</div>
          <div className="appearance-options">
            {APPEARANCES.map(preset => <button key={preset.key} type="button"
              disabled={appearanceBusy} aria-pressed={getAppearance(local).key === preset.key}
              onClick={async () => {
                setAppearanceBusy(true)
                setAppearanceError('')
                try {
                  await window.electronAPI.updateSetting('appearance', preset.key)
                  updateSetting('appearance', preset.key)
                  setLocal(previous => ({ ...previous, appearance: preset.key }))
                  broadcastAppearance(preset.key)
                } catch { setAppearanceError('外观保存失败，请重试。') }
                finally { setAppearanceBusy(false) }
              }}>
              <span className="appearance-thumbnail" data-preset={preset.key}
                style={{ background: preset.reading, color: preset.ink, borderColor: preset.ink + '22' }}>
                <span className="appearance-thumbnail-bar" style={{ background: preset.panel }}>Aa<span>···</span></span>
                <span className="appearance-thumbnail-body"><i /><i /><i /></span>
              </span>
              <span className="appearance-option-label"><strong>{preset.name}</strong><span className="appearance-radio" /></span>
              <small>{preset.desc}</small>
            </button>)}
          </div>
          {appearanceError && <p className="workspace-error" role="alert">{appearanceError}</p>}
          <div className="mt-4">
            <div className="flex justify-between text-sm theme-text-secondary mb-1"><span>字体大小</span><span>{local.font_size || 16}px</span></div>
            <input type="range" min="13" max="36" step="1" value={Number(local.font_size || 16)} onChange={e => set('font_size', e.target.value)} className="w-full" />
          </div>
          <div className="mt-3">
            <Row label="字体">
              <select value={local.font_family || 'system'} onChange={e => set('font_family', e.target.value)} className={inp + ' w-28'}>
                {FONTS.map(f => <option key={f.key} value={f.key}>{f.name}</option>)}
              </select>
            </Row>
          </div>
        </Section>

      </div>
      </SettingsTab.Provider>
    </div>
    </div>
  )
}

function PublicationYear() {
  const saved = useStore(s => s.settings.year_from)
  const updateSetting = useStore(s => s.updateSetting)
  const [draft, setDraft] = useState(saved || '2025')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { if (saved !== undefined) setDraft(saved) }, [saved])

  const save = async () => {
    const year = Number(draft)
    if (!Number.isInteger(year) || year < 1 || year > 9999) {
      setError('请输入 1–9999 之间的整数年份。')
      return
    }
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const value = String(year)
      await window.electronAPI.updateSetting('year_from', value)
      updateSetting('year_from', value)
      setDraft(value)
      setMessage('已保存，后续采集、翻译和推送使用此年份。')
    } catch { setError('保存失败，请重试。') }
    finally { setBusy(false) }
  }

  return <div className="publication-year">
    <Row label="最低出版年份"><div className="publication-year-controls">
      <input type="number" aria-label="最低出版年份" min="1" max="9999" step="1" value={draft} disabled={busy}
        onChange={e => { setDraft(e.target.value); setMessage(''); setError('') }} />
      <button type="button" disabled={busy || saved === undefined} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button>
    </div></Row>
    {message && <p className="theme-text-subtle text-xs mt-2" role="status">{message}</p>}
    {error && <p className="workspace-error" role="alert">{error}</p>}
  </div>
}

function PushKeywords() {
  const saved = useStore(s => s.settings.push_keywords)
  const updateSetting = useStore(s => s.updateSetting)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (saved === undefined) return
    try { setDraft((JSON.parse(saved) as string[]).join(', ')) }
    catch { setError('关键词加载失败，请重新打开设置。') }
  }, [saved])

  const save = async () => {
    setBusy(true)
    setError('')
    setMessage('')
    const keywords = new Map<string, string>()
    for (const item of draft.split(/[,，;；\n]+/)) {
      const keyword = item.normalize('NFKC').trim().replace(/\s+/g, ' ')
      if (keyword && !keywords.has(keyword.toLowerCase())) keywords.set(keyword.toLowerCase(), keyword)
    }
    const value = JSON.stringify([...keywords.values()])
    try {
      await window.electronAPI.updateSetting('push_keywords', value)
      updateSetting('push_keywords', value)
      setDraft([...keywords.values()].join(', '))
      setMessage('已保存，下次生成或补充推送时生效。')
    } catch { setError('保存失败，请重试。') }
    finally { setBusy(false) }
  }

  return <div className="push-keywords">
    <label htmlFor="push-keywords-input">推送关键词</label>
    <textarea id="push-keywords-input" rows={4} value={draft} disabled={busy || saved === undefined}
      placeholder="输入关键词，用逗号或换行分隔" aria-describedby="push-keywords-help"
      onChange={e => { setDraft(e.target.value); setMessage(''); setError('') }} />
    <p id="push-keywords-help">用逗号或换行分隔。标题和摘要命中的关键词越多越优先。</p>
    <div className="push-keywords-actions">
      <span role="status">{message}</span>
      <button type="button" disabled={busy || saved === undefined} onClick={() => void save()}>{busy ? '保存中…' : '保存关键词'}</button>
    </div>
    {error && <p className="workspace-error" role="alert">{error}</p>}
  </div>
}

function ArticleStatistics() {
  const [data, setData] = useState<Awaited<ReturnType<typeof window.electronAPI.getArticleStatistics>> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const refresh = async () => {
    setLoading(true)
    setError('')
    try { setData(await window.electronAPI.getArticleStatistics()) }
    catch { setError('统计查询失败，请重试。') }
    finally { setLoading(false) }
  }
  const totals = data?.rows.reduce((sum, row) => ({ total: sum.total + row.total, translated: sum.translated + row.translated, available: sum.available + row.available }), { total: 0, translated: 0, available: 0 })
  return <div className="article-statistics">
    <div className="article-statistics-header">
      <span className="theme-text-subtle">{data ? `最近更新 ${new Date(data.updatedAt).toLocaleString()}` : '点击刷新查看文章统计'}</span>
      <button type="button" onClick={() => void refresh()} disabled={loading}>{loading ? '查询中…' : '刷新'}</button>
    </div>
    {error && <p className="workspace-error" role="alert">{error}</p>}
    {data && <div className="article-statistics-scroll"><table>
      <thead><tr><th>来源</th><th>已入库</th><th>已翻译</th><th>可推送</th></tr></thead>
      <tbody>{data.rows.map((row, index) => <tr key={`${row.name}-${index}`}><td>{row.name}</td><td>{row.total.toLocaleString()}</td><td>{row.translated.toLocaleString()}</td><td>{row.available.toLocaleString()}</td></tr>)}
        {totals && <tr className="article-statistics-total"><td>合计</td><td>{totals.total.toLocaleString()}</td><td>{totals.translated.toLocaleString()}</td><td>{totals.available.toLocaleString()}</td></tr>}
      </tbody>
    </table></div>}
  </div>
}

function SecretSetting({ label, settingKey, placeholder }: { label: string; settingKey: string; placeholder: string }) {
  const configured = useStore(s => s.settings[`${settingKey}_configured`] === 'true')
  const updateSetting = useStore(s => s.updateSetting)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async (value: string) => {
    setBusy(true)
    setError('')
    try {
      const result = await window.electronAPI.updateSetting(settingKey, value)
      updateSetting(settingKey, '')
      updateSetting(`${settingKey}_configured`, String(result.configured ?? !!value))
      setDraft('')
    } catch {
      setError('保存失败，请检查系统安全存储后重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="paper-secret">
      <Row label={label}>
        <div className="paper-secret-field">
          <input type="password" autoComplete="new-password" value={draft} disabled={busy}
            onChange={e => setDraft(e.target.value)} aria-label={label}
            className="w-full px-2 py-1 rounded-lg theme-bg-overlay-strong theme-text-secondary text-sm border theme-border outline-none"
            placeholder={configured ? '已配置；输入新值可替换' : placeholder} />
          <div className="flex items-center gap-2 text-xs">
            <span className="theme-text-subtle">{configured ? '已配置' : '未配置'}</span>
            <button disabled={busy || !draft.trim()} onClick={() => void save(draft.trim())}
              className="theme-accent-text disabled:opacity-40">{busy ? '保存中…' : '保存'}</button>
            {configured && <button disabled={busy} onClick={() => {
              if (confirm(`确定删除 ${label} 的已保存密钥？`)) void save('')
            }} className="text-red-400 disabled:opacity-40">删除</button>}
          </div>
        </div>
      </Row>
      {error && <div className="text-xs text-red-400">{error}</div>}
    </div>
  )
}

function QuotaDashboard() {
  const [data, setData] = useState<any>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  useEffect(() => {
    window.electronAPI.getQuotaOverview().then(setData).catch((err: any) => setData({ ok: false, error: String(err) }))
  }, [refreshKey])

  const statusColor = (s: string) => s === 'normal' ? 'text-green-400' : s === 'warning' ? 'text-yellow-400' : s === 'paused' ? 'text-red-400' : 'text-red-400'
  const statusLabel = (s: string) => s === 'normal' ? '正常' : s === 'warning' ? '⚠ 接近限额' : s === 'paused' ? '⛔ 已暂停' : s === 'error' ? '❌ 错误' : '不限'

  const barColor = (s: string) => s === 'normal' ? 'bg-green-500/60' : s === 'warning' ? 'bg-yellow-500/70' : 'bg-red-500/70'

  if (!data) return <div className="text-xs theme-text-subtle">加载中...</div>
  if (data.ok === false) return <div className="text-xs text-red-400">额度仪表盘加载失败: {data.error || '未知错误'}</div>

  const quotaCard = (p: any) => (
    <div key={p.provider} className="rounded-xl p-3 theme-bg-overlay border theme-border-light space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium theme-text-secondary">{p.displayName}</span>
        <span className={`text-[11px] font-medium ${statusColor(p.status)}`}>{statusLabel(p.status)}</span>
      </div>
      {p.limitWan > 0 ? (
        <>
          <div>
            <div className="flex justify-between text-[11px] theme-text-muted mb-0.5">
              <span>{p.usedChars.toLocaleString()} / {p.limitChars.toLocaleString()} 字符</span>
              <span>{p.percentText}</span>
            </div>
            <div className="h-1.5 rounded-full theme-bg-overlay-strong overflow-hidden">
              <div className={`h-full rounded-full transition-all ${barColor(p.status)}`}
                style={{ width: Math.min(100, (p.percent || 0) * 100) + '%' }} />
            </div>
          </div>
          <div className="text-[10px] theme-text-subtle space-y-0.5">
            <div>提醒线: {p.warnAtChars.toLocaleString()} ({Math.round(p.warnRatio * 100)}%) · 停止线: {p.stopAtChars.toLocaleString()} ({Math.round(p.stopRatio * 100)}%)</div>
            {p.remainingToStop !== null && p.status !== 'paused' && (
              <div>距自动停止: {p.remainingToStop.toLocaleString()} 字符</div>
            )}
            {p.reason && <div className={statusColor(p.status)}>{p.reason}</div>}
          </div>
        </>
      ) : (
        <div className="text-[11px] text-yellow-400">限额未设置 (不推荐)</div>
      )}
      <div className="flex gap-1 flex-wrap">
        <button onClick={async () => { if (confirm(`确定恢复${p.displayName}？`)) { await window.electronAPI.recoverTranslationProvider(p.provider); setRefreshKey(k => k + 1); } }} className="text-[9px] px-1.5 py-0.5 rounded theme-bg-overlay-strong theme-text-muted hover:theme-text-secondary">恢复</button>
        <button onClick={async () => { if (confirm(`确定重置${p.displayName}本月统计？`)) { await window.electronAPI.resetTranslationStats(p.provider); setRefreshKey(k => k + 1); } }} className="text-[9px] px-1.5 py-0.5 rounded theme-bg-overlay-strong theme-text-muted hover:theme-text-secondary">重置统计</button>
        <button onClick={async () => {
          if (confirm(`确定将${p.displayName}标记为已用完全月额度？\n这将把初始已用量设为 ${p.limitWan} 万字符并自动暂停。`)) {
            await window.electronAPI.updateSetting(p.provider + '_initial_used_chars', String(p.limitWan))
            const now = new Date()
            const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
            await window.electronAPI.updateSetting(p.provider + '_initial_used_month', month)
            setRefreshKey(k => k + 1)
          }
        }} className="text-[9px] px-1.5 py-0.5 rounded theme-bg-overlay-strong text-red-400 hover:text-red-300">额度用完</button>
      </div>
      <div className="flex items-center gap-1 text-[10px] mt-1">
        <span className="theme-text-muted">初始已用(万):</span>
        <input type="number" defaultValue={p.initialUsedWan} onChange={e => {
          window.electronAPI.updateSetting(p.provider + '_initial_used_chars', e.target.value)
          const now = new Date()
          const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
          window.electronAPI.updateSetting(p.provider + '_initial_used_month', month)
          setRefreshKey(k => k + 1)
        }} min="0" step="1" className="w-12 px-1 py-0.5 rounded theme-bg-overlay-strong theme-text-secondary text-[10px] border theme-border-light outline-none" />
      </div>
      <div className="text-[10px] theme-text-subtle italic">{p.cloudStatus.usageNote}</div>
    </div>
  )

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className={statusColor(data.globalStatus)}>● {statusLabel(data.globalStatus)}</span>
        <span className="theme-text-muted">| 主引擎: {data.activeProvider === 'aliyun' ? '阿里云' : 'Ollama'}</span>
        <span className="theme-text-muted">| 降级: {data.allowFallback ? '开' : '关'}</span>
      </div>
      <div className="text-[10px] theme-text-subtle">统计周期: {data.monthLabel} · 本地统计，不等同于云端账单</div>
      {!data.localUsageOk && <div className="text-xs text-red-400">⚠ {data.localUsageError}</div>}
      {quotaCard(data.providers.aliyun)}
      <div className="text-[10px] theme-text-subtle italic">
        免费额度: 阿里云 100万/月 · Ollama 本地不计入
      </div>
    </div>
  )
}

function Section({ title, group, children }: { title: string; group: string; children: React.ReactNode }) {
  const tab = useContext(SettingsTab)
  return <section className="paper-setting-section" hidden={group !== tab}>
    <h3>{title}</h3><div className="paper-setting-card">{children}</div>
  </section>
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="paper-setting-row"><span className="theme-text-secondary">{label}</span>{children}</div>
}
