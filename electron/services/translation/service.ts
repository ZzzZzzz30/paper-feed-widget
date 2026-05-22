import { getDb, saveNow } from '../db'
import { TranslateInput, TranslateResult, TranslationUsage } from './types'
import { translateWithTencent } from './tencent-translator'
import { translateWithAliyun } from './aliyun-translator'
import { translateWithOllama } from './ollama-translator'

// ── Markdown 清理 ──────────────────────────────────────

function cleanMarkdown(text: string): string {
  return text
    .replace(/^\*{1,3}\s*/g, '').replace(/\*{1,3}$/g, '').replace(/\*{1,2}/g, '')
    .replace(/^#{1,4}\s*/g, '').replace(/^_{1,3}\s*/g, '').replace(/_{1,3}$/g, '')
    .trim()
}

// ── 设置读取 ──────────────────────────────────────────

function getSetting(key: string, fallback: string): string {
  try {
    const db = getDb()
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value?: string } | undefined
    return row?.value || fallback
  } catch { return fallback }
}

function getFloatSetting(key: string, fallback: number): number {
  const v = parseFloat(getSetting(key, String(fallback)))
  return isNaN(v) ? fallback : v
}

function getIntSetting(key: string, fallback: number): number {
  const v = parseInt(getSetting(key, String(fallback)), 10)
  return isNaN(v) ? fallback : v
}

// ── 用量查询 (fail-closed, 按月统计) ─────────────────

function startOfMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
}

export function getTranslationUsage(): TranslationUsage & { ok: boolean; error?: string } {
  try {
    const db = getDb()
    const monthStart = startOfMonth()
    const rows = db.prepare(`
      SELECT provider, COALESCE(SUM(char_count), 0) as chars
      FROM translation_usage WHERE success = 1 AND created_at >= ?
      GROUP BY provider
    `).all(monthStart) as Array<{ provider: string; chars: number }>
    const map: Record<string, number> = {}
    for (const r of rows) map[r.provider] = r.chars
    return {
      tencentChars: map.tencent || 0,
      aliyunChars: map.aliyun || 0,
      ollamaChars: map.ollama || 0,
      totalChars: (map.tencent || 0) + (map.aliyun || 0) + (map.ollama || 0),
      ok: true,
    }
  } catch (err) {
    console.error('[Translation] 用量读取失败:', err)
    try {
      const db = getDb()
      for (const p of ['tencent', 'aliyun']) {
        setControlStatus(p, 'paused', '用量读取失败，为防止超额已暂停云端翻译')
      }
      saveNow()
    } catch {}
    return { tencentChars: 0, aliyunChars: 0, ollamaChars: 0, totalChars: 0, ok: false, error: '用量读取失败，云端翻译已暂停' }
  }
}

function setControlStatus(provider: string, status: string, reason: string): void {
  try {
    getDb().prepare("INSERT OR REPLACE INTO translation_control (provider, status, reason, updated_at) VALUES (?, ?, ?, datetime('now'))").run(provider, status, reason)
  } catch {}
}

// ── 用量记录 (fail-closed) ────────────────────────────

function recordTranslation(provider: string, articleId: number, charCount: number): boolean {
  try {
    const db = getDb()
    db.prepare(`
      INSERT INTO translation_usage (provider, article_id, char_count, success)
      VALUES (?, ?, ?, 1)
    `).run(provider, articleId, charCount)
    saveNow()
    return true
  } catch (err) {
    console.error(`[Translation] 用量记录失败! provider=${provider}, chars=${charCount}:`, err)
    // 写入失败 → 标记该 provider 暂停
    try {
      getDb().prepare(`
        INSERT OR REPLACE INTO translation_control (provider, status, reason, updated_at)
        VALUES (?, 'paused', '用量记录失败，为防止超额已暂停云端翻译', datetime('now'))
      `).run(provider)
      saveNow()
    } catch {}
    return false
  }
}

// ── 限额检查（包含本次请求 + warn/stop 两级）────────────────

function checkLimit(provider: string, charCount: number): { ok: boolean; warn: boolean; reason: string } {
  const usage = getTranslationUsage()
  if (!usage.ok) {
    return { ok: false, warn: false, reason: usage.error || '用量读取失败' }
  }

  const initialUsed = getIntSetting(`${provider}_initial_used_chars`, 0) * 10000
  const localUsed = (provider === 'tencent' ? usage.tencentChars : usage.aliyunChars)
  const limit = getIntSetting(`${provider}_char_limit`, 0) * 10000

  if (limit <= 0) return { ok: true, warn: false, reason: '' }

  // 关键修复：用预计用量（已用 + 本次）判断
  const projectedUsed = initialUsed + localUsed + charCount
  const projectedRatio = projectedUsed / limit
  const warnRatio = getFloatSetting(`${provider}_warn_ratio`, 0.8)
  const stopRatio = getFloatSetting(`${provider}_stop_ratio`, 0.9)

  if (projectedUsed > limit) {
    return { ok: false, warn: false, reason: `${provider} 本次翻译后 ${projectedUsed.toLocaleString()} 字符将超过限额 ${limit.toLocaleString()}，已拒绝` }
  }
  if (projectedRatio >= stopRatio) {
    return { ok: false, warn: false, reason: `${provider} 已达 ${Math.round(projectedRatio * 100)}% 限额 (${projectedUsed.toLocaleString()}/${limit.toLocaleString()})，自动暂停` }
  }
  if (projectedRatio >= warnRatio) {
    console.warn(`[Translation] ${provider} 接近限额: ${Math.round(projectedRatio * 100)}% (${projectedUsed.toLocaleString()}/${limit.toLocaleString()})`)
    return { ok: true, warn: true, reason: `${provider} 已用 ${Math.round(projectedRatio * 100)}% 限额，接近上限` }
  }
  return { ok: true, warn: false, reason: '' }
}

function isProviderPaused(provider: string): boolean {
  try {
    const db = getDb()
    const row = db.prepare("SELECT status FROM translation_control WHERE provider = ? AND status = 'paused'").get(provider)
    return !!row
  } catch { return false }
}

function pauseProvider(provider: string, reason: string): void {
  try {
    const db = getDb()
    db.prepare(`
      INSERT OR REPLACE INTO translation_control (provider, status, reason, updated_at)
      VALUES (?, 'paused', ?, datetime('now'))
    `).run(provider, reason)
    saveNow()
  } catch {}
}

// ── 主翻译入口 ────────────────────────────────────────

export async function translateArticle(input: TranslateInput): Promise<TranslateResult> {
  const charCount = input.title.length + input.abstract.length

  // 读取 provider 设置，决定调用顺序
  const provider = getSetting('translation_provider', 'tencent')
  const allowFallback = getSetting('allow_translation_fallback', 'true') === 'true'

  // 检查 providers 是否被暂停
  const tencentPaused = isProviderPaused('tencent')
  const aliyunPaused = isProviderPaused('aliyun')

  // 构建执行链
  const chain: Array<{ name: string; fn: () => Promise<TranslateResult>; enabled: boolean }> = []

  if (provider === 'tencent') {
    chain.push({ name: 'tencent', fn: () => translateWithTencent(input), enabled: !tencentPaused })
    if (allowFallback) {
      chain.push({ name: 'aliyun', fn: () => translateWithAliyun(input), enabled: !aliyunPaused })
    }
  } else if (provider === 'aliyun') {
    chain.push({ name: 'aliyun', fn: () => translateWithAliyun(input), enabled: !aliyunPaused })
    if (allowFallback) {
      chain.push({ name: 'tencent', fn: () => translateWithTencent(input), enabled: !tencentPaused })
    }
  }

  // Ollama 始终作为最后兜底（本地服务，不限额）
  chain.push({ name: 'ollama', fn: () => translateWithOllama(input), enabled: true })

  // 按链执行
  let lastError = ''
  for (const step of chain) {
    if (!step.enabled) { console.log(`[Translation] #${input.articleId} ${step.name} 已暂停，跳过`); continue }

    // 云端服务需要限额检查（传入本次 charCount）
    if (step.name === 'tencent' || step.name === 'aliyun') {
      const limitCheck = checkLimit(step.name, charCount)
      if (!limitCheck.ok) {
        console.log(`[Translation] #${input.articleId} ${limitCheck.reason}`)
        pauseProvider(step.name, limitCheck.reason)
        continue
      }
      if (limitCheck.warn) {
        console.log(`[Translation] #${input.articleId} ${limitCheck.reason}`)
        setControlStatus(step.name, 'warning', limitCheck.reason)
      }
    }

    try {
      console.log(`[Translation] #${input.articleId} ${step.name}...`)
      const result = await step.fn()

      // 记录用量（云端服务才需要记录字符）
      if (step.name === 'tencent' || step.name === 'aliyun') {
        const recorded = recordTranslation(step.name, input.articleId, charCount)
        if (!recorded) {
          pauseProvider(step.name, '翻译已完成但用量记录失败，为防止重复消耗云端额度已暂停')
          throw new Error(`${step.name} 翻译已完成但用量记录失败，已暂停该服务`)
        }
      }

      result.title_cn = cleanMarkdown(result.title_cn)
      result.abstract_cn = cleanMarkdown(result.abstract_cn)
      console.log(`[Translation] #${input.articleId} ${step.name} ok: ${result.title_cn.slice(0, 30)}`)
      return result
    } catch (e) {
      lastError = String(e)
      console.warn(`[Translation] #${input.articleId} ${step.name} 失败: ${lastError}`)
      // 非 Ollama 失败时，不自动跳到下一个（除非 allowFallback）
      if (step.name !== 'ollama' && !allowFallback) break
    }
  }

  // 全部失败，抛出错误
  throw new Error(lastError || '所有翻译服务均不可用')
}

export { getSetting, getFloatSetting, getIntSetting, isProviderPaused, pauseProvider }
