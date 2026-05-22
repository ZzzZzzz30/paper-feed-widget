import { useState, useEffect } from 'react'
import { useStore } from '../store'

const THEMES = [
  { key: 'dark', name: '深色', desc: '默认暗色', colors: ['#121218', '#1f2937', '#60a5fa'] },
  { key: 'light', name: '亮色', desc: '浅色阅读', colors: ['#f8fafc', '#ffffff', '#2563eb'] },
  { key: 'midnight', name: '午夜蓝', desc: '低亮度蓝紫', colors: ['#070a19', '#0f172a', '#6366f1'] },
  { key: 'forest', name: '森林绿', desc: '自然绿色', colors: ['#0a120e', '#12231a', '#22c55e'] },
  { key: 'rose', name: '玫瑰金', desc: '暖色强调', colors: ['#1c0f18', '#2a1824', '#ec4899'] },
  { key: 'paper', name: '纸张', desc: '文献阅读', colors: ['#f3efe7', '#fffaf0', '#b45309'] },
]
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
  const [local, setLocal] = useState<Record<string, string>>({})

  useEffect(() => { setLocal({ ...settings }) }, [settings])

  const set = async (k: string, v: string) => {
    let value = v
    if ((k === 'font_size') && value.endsWith('px')) value = value.replace('px', '')
    setLocal(p => ({ ...p, [k]: value }))
    try {
      await window.electronAPI.updateSetting(k, value)
      console.log(`[SettingsPanel] updateSetting ${k} = ${value} OK`)
    } catch (err) {
      console.error(`[SettingsPanel] updateSetting ${k} 失败:`, err)
    }
    updateSetting(k, value)
    if (k === 'theme') {
      document.documentElement.setAttribute('data-theme', value)
    }
    if (k === 'font_size') {
      document.documentElement.style.setProperty('--app-font-size', value + 'px')
      document.documentElement.style.fontSize = value + 'px'
    }
    if (k === 'font_family') {
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
      <div className="w-full h-full theme-window flex flex-col">
      <div className="drag-handle shrink-0 flex items-center justify-between px-4 py-3 border-b theme-border-light">
        <span className="text-sm theme-text-secondary font-medium">⚙️ 设置</span>
        <button onClick={() => setView(previousView)} className="no-drag theme-text-muted hover:theme-text-main text-sm">✕</button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        <Section title="API 密钥">
          <Row label="Elsevier"><input type="password" value={local.elsevier_api_key || ''} onChange={e => set('elsevier_api_key', e.target.value)} className={inp} placeholder="ScienceDirect API Key" /></Row>
          <Row label="腾讯云 SecretId"><input type="password" value={local.tencent_secret_id || ''} onChange={e => set('tencent_secret_id', e.target.value)} className={inp} placeholder="AKID..." /></Row>
          <Row label="腾讯云 SecretKey"><input type="password" value={local.tencent_secret_key || ''} onChange={e => set('tencent_secret_key', e.target.value)} className={inp} placeholder="SecretKey" /></Row>
          <Row label="阿里云 AK ID"><input type="password" value={local.aliyun_access_key_id || ''} onChange={e => set('aliyun_access_key_id', e.target.value)} className={inp} placeholder="LTAI..." /></Row>
          <Row label="阿里云 AK Secret"><input type="password" value={local.aliyun_access_key_secret || ''} onChange={e => set('aliyun_access_key_secret', e.target.value)} className={inp} placeholder="Secret" /></Row>
          <Row label="DeepSeek"><input type="password" value={local.deepseek_api_key || ''} onChange={e => set('deepseek_api_key', e.target.value)} className={inp} placeholder="sk-..." /></Row>
          <Row label="DeepSeek 输入价"><input type="number" value={local.deepseek_input_price || '0.14'} onChange={e => set('deepseek_input_price', e.target.value)} step="0.01" className={inp + ' w-20'} /><span className="text-xs theme-text-subtle">$/M tokens</span></Row>
          <Row label="DeepSeek 输出价"><input type="number" value={local.deepseek_output_price || '0.28'} onChange={e => set('deepseek_output_price', e.target.value)} step="0.01" className={inp + ' w-20'} /><span className="text-xs theme-text-subtle">$/M tokens</span></Row>
          <div className="text-xs theme-text-subtle mt-1">--- DeepSeek 预算 ---</div>
          <Row label="本月预算 ($)"><input type="number" value={local.deepseek_monthly_budget_usd || '2'} onChange={e => set('deepseek_monthly_budget_usd', e.target.value)} step="0.5" min="0" className={inp + ' w-20'} /><span className="text-xs theme-text-subtle">0=不限</span></Row>
          <Row label="初始已用 ($)"><input type="number" value={local.deepseek_initial_used_usd || '0'} onChange={e => set('deepseek_initial_used_usd', e.target.value)} step="0.01" min="0" className={inp + ' w-20'} /></Row>
        </Section>

        <Section title="推送">
          <Row label="年份从"><input type="number" value={local.year_from || '2015'} onChange={e => set('year_from', e.target.value)} min="2000" max="2026" className={inp + ' w-20'} /></Row>
          <Row label="每轮篇数"><input type="number" value={local.push_count || '20'} onChange={e => set('push_count', e.target.value)} min="5" max="100" className={inp + ' w-20'} /></Row>
        </Section>

        <Section title="翻译额度与安全">
          <Row label="引擎"><select value={local.translation_provider || 'tencent'} onChange={e => set('translation_provider', e.target.value)} className={inp + ' w-24'}><option value="tencent">腾讯云</option><option value="aliyun">阿里云</option><option value="ollama">Ollama</option></select></Row>
          <Row label="失败时自动降级">
            <select value={local.allow_translation_fallback || 'false'} onChange={e => set('allow_translation_fallback', e.target.value)} className={inp + ' w-20'}>
              <option value="true">允许</option><option value="false">禁止</option>
            </select>
          </Row>
          <QuotaDashboard />
        </Section>

        <Section title="外观">
          <div className="text-sm theme-text-secondary mb-2">主题</div>
          <div className="grid grid-cols-2 gap-2">
            {THEMES.map(t => (
              <button key={t.key} onClick={() => set('theme', t.key)} className="no-drag rounded-xl p-3 text-left border transition"
                style={{ borderColor: local.theme === t.key ? 'rgb(var(--accent-rgb) / 0.7)' : 'rgb(var(--border-rgb) / 0.12)', background: 'rgb(var(--panel-bg-rgb) / 0.6)' }}>
                <div className="flex gap-1 mb-2">{t.colors.map(c => <span key={c} className="w-5 h-5 rounded-full border theme-border-light" style={{ background: c }} />)}</div>
                <div className="text-sm font-medium theme-text-main">{t.name}</div>
                <div className="text-[11px] theme-text-muted">{t.desc}</div>
              </button>
            ))}
          </div>
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
          <label className="flex items-center gap-2 text-sm theme-text-secondary mt-3">
            <input type="checkbox" defaultChecked={local.auto_start === 'true'} onChange={e => set('auto_start', String(e.target.checked))} className="rounded theme-bg-overlay-strong theme-border" />开机自启动
          </label>
        </Section>

        <Section title="DeepSeek 用量"><DeepSeekUsage /></Section>
      </div>
    </div>
    </div>
  )
}

function DeepSeekUsage() {
  const local = useStore(s => s.settings)
  const [usage, setUsage] = useState<{ input: number; output: number; total: number; cost: number } | null>(null)
  useEffect(() => {
    window.electronAPI.getDeepSeekUsage?.().then(setUsage).catch(() => {})
  }, [])
  const budget = parseFloat(local.deepseek_monthly_budget_usd || '2') || 0
  const initialUsed = parseFloat(local.deepseek_initial_used_usd || '0') || 0
  const localCost = usage?.cost || 0
  const usedCost = initialUsed + localCost
  const percent = budget > 0 ? usedCost / budget : null
  const pctText = percent !== null ? (percent * 100).toFixed(1) + '%' : '不限'
  const warnRatio = parseFloat(local.deepseek_warn_ratio || '0.8')
  const stopRatio = parseFloat(local.deepseek_stop_ratio || '0.9')
  const stopAt = budget * stopRatio
  const s = percent !== null && percent >= stopRatio ? 'paused' : percent !== null && percent >= warnRatio ? 'warning' : 'normal'
  const barC = s === 'normal' ? 'bg-green-500/60' : s === 'warning' ? 'bg-yellow-500/70' : 'bg-red-500/70'
  const statusC = s === 'normal' ? 'text-green-400' : s === 'warning' ? 'text-yellow-400' : 'text-red-400'
  const statusL = s === 'normal' ? '正常' : s === 'warning' ? '⚠ 接近预算' : '⛔ 已暂停'

  if (!usage) return <div className="text-xs theme-text-subtle">加载中...</div>
  return (
    <div className="rounded-xl p-3 theme-bg-overlay border theme-border-light space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium theme-text-secondary">DeepSeek API</span>
        <span className={`text-[11px] font-medium ${statusC}`}>{statusL}</span>
      </div>
      {budget > 0 ? (
        <>
          <div>
            <div className="flex justify-between text-[11px] theme-text-muted mb-0.5">
              <span>${usedCost.toFixed(4)} / ${budget.toFixed(2)}</span>
              <span>{pctText}</span>
            </div>
            <div className="h-1.5 rounded-full theme-bg-overlay-strong overflow-hidden">
              <div className={`h-full rounded-full ${barC}`} style={{ width: Math.min(100, (percent || 0) * 100) + '%' }} />
            </div>
          </div>
          <div className="text-[10px] theme-text-subtle">
            提醒线: ${(budget * warnRatio).toFixed(2)} · 停止线: ${stopAt.toFixed(2)}
            {percent !== null && percent < stopRatio && <span> · 距停止: ${(stopAt - usedCost).toFixed(4)}</span>}
          </div>
        </>
      ) : (
        <div className="text-[11px] text-yellow-400">未设置预算 (不推荐)</div>
      )}
      <div className="text-[10px] theme-text-secondary space-y-0.5">
        <div>输入: {usage.input.toLocaleString()} tokens · 输出: {usage.output.toLocaleString()} tokens</div>
        <div>本月估算: ${localCost.toFixed(4)} · 初始已用: ${initialUsed.toFixed(2)}</div>
      </div>
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
            setRefreshKey(k => k + 1)
          }
        }} className="text-[9px] px-1.5 py-0.5 rounded theme-bg-overlay-strong text-red-400 hover:text-red-300">额度用完</button>
      </div>
      <div className="flex items-center gap-1 text-[10px] mt-1">
        <span className="theme-text-muted">初始已用(万):</span>
        <input type="number" defaultValue={p.initialUsedWan} onChange={e => { window.electronAPI.updateSetting(p.provider + '_initial_used_chars', e.target.value); setRefreshKey(k => k + 1) }} min="0" step="1" className="w-12 px-1 py-0.5 rounded theme-bg-overlay-strong theme-text-secondary text-[10px] border theme-border-light outline-none" />
      </div>
      <div className="text-[10px] theme-text-subtle italic">{p.cloudStatus.usageNote}</div>
    </div>
  )

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className={statusColor(data.globalStatus)}>● {statusLabel(data.globalStatus)}</span>
        <span className="theme-text-muted">| 主引擎: {data.activeProvider === 'tencent' ? '腾讯云' : data.activeProvider === 'aliyun' ? '阿里云' : 'Ollama'}</span>
        <span className="theme-text-muted">| 降级: {data.allowFallback ? '开' : '关'}</span>
      </div>
      <div className="text-[10px] theme-text-subtle">统计周期: {data.monthLabel} · 本地统计，不等同于云端账单</div>
      {!data.localUsageOk && <div className="text-xs text-red-400">⚠ {data.localUsageError}</div>}
      {quotaCard(data.providers.tencent)}
      {quotaCard(data.providers.aliyun)}
      <div className="text-[10px] theme-text-subtle italic">
        免费额度: 腾讯云 500万/月 | 阿里云 100万/月 · Ollama 本地不计入
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="space-y-2.5"><h3 className="text-sm font-medium theme-text-muted border-b theme-border-light pb-1">{title}</h3>{children}</div>
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex items-center justify-between"><span className="text-sm theme-text-secondary">{label}</span>{children}</div>
}
