import { getDb, saveNow } from '../db'
import { TranslateInput, TranslateResult, TranslationUsage, TranslationFailedError, TranslationUnavailableError } from './types'
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

export function getSetting(key: string, fallback: string): string {
  try {
    const db = getDb()
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value?: string } | undefined
    return row?.value || fallback
  } catch { return fallback }
}

export function getFloatSetting(key: string, fallback: number): number {
  const v = parseFloat(getSetting(key, String(fallback)))
  return isNaN(v) ? fallback : v
}

export function getIntSetting(key: string, fallback: number): number {
  const v = parseInt(getSetting(key, String(fallback)), 10)
  return isNaN(v) ? fallback : v
}

// ── 用量查询 (fail-closed, 按月统计) ─────────────────

function startOfMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
}

function currentMonthKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
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
      aliyunChars: map.aliyun || 0,
      ollamaChars: map.ollama || 0,
      totalChars: (map.aliyun || 0) + (map.ollama || 0),
      ok: true,
    }
  } catch (err) {
    console.error('[Translation] 用量读取失败:', err)
    try {
      setControlStatus('aliyun', 'paused', '用量读取失败，为防止超额已暂停云端翻译')
      saveNow()
    } catch {}
    return { aliyunChars: 0, ollamaChars: 0, totalChars: 0, ok: false, error: '用量读取失败，云端翻译已暂停' }
  }
}

function setControlStatus(provider: string, status: string, reason: string): void {
  try {
    getDb().prepare("INSERT OR REPLACE INTO translation_control (provider, status, reason, updated_at) VALUES (?, ?, ?, datetime('now'))").run(provider, status, reason)
  } catch {}
}

// ── 限额检查（含月初自动复位）────────────────────────

// 按月份隔离 initial_used_chars：仅当月设置的值生效
function getMonthlyInitialWan(provider: string): number {
  const month = currentMonthKey()
  const savedMonth = getSetting(`${provider}_initial_used_month`, '')
  if (savedMonth !== month) return 0 // 新月份，旧值不生效
  return getIntSetting(`${provider}_initial_used_chars`, 0)
}

function checkLimit(provider: string, charCount: number): { ok: boolean; warn: boolean; reason: string } {
  const usage = getTranslationUsage()
  if (!usage.ok) {
    return { ok: false, warn: false, reason: usage.error || '用量读取失败' }
  }

  // 注意：*_char_limit / *_initial_used_chars 的单位是"万字符"
  const initialUsed = getMonthlyInitialWan(provider) * 10000
  const localUsed = usage.aliyunChars
  const limit = getIntSetting(`${provider}_char_limit`, 100) * 10000

  if (limit <= 0) return { ok: true, warn: false, reason: '' }

  const projectedUsed = initialUsed + localUsed + charCount
  const projectedRatio = projectedUsed / limit
  const warnRatio = getFloatSetting(`${provider}_warn_ratio`, 0.8)
  const stopRatio = getFloatSetting(`${provider}_stop_ratio`, 0.9)

  if (projectedUsed > limit) {
    return { ok: false, warn: false, reason: `${provider} 本次翻译后 ${projectedUsed.toLocaleString()} 字符将超过限额 ${limit.toLocaleString()}，已拒绝` }
  }
  if (projectedRatio >= stopRatio) {
    return { ok: false, warn: false, reason: `${provider} 已达 ${Math.round(projectedRatio * 100)}% 限额，自动暂停` }
  }
  if (projectedRatio >= warnRatio) {
    return { ok: true, warn: true, reason: `${provider} 已用 ${Math.round(projectedRatio * 100)}% 限额，接近上限` }
  }
  return { ok: true, warn: false, reason: '' }
}

// ── 用量预占（调用云端 API 前执行，fail-closed）────────

function reserveTranslationUsage(provider: string, articleId: number, charCount: number): { ok: boolean; warn: boolean; reason: string } {
  const limitCheck = checkLimit(provider, charCount)
  if (!limitCheck.ok) return limitCheck

  try {
    const db = getDb()
    db.prepare("INSERT INTO translation_usage (provider, article_id, char_count, success) VALUES (?, ?, ?, 1)").run(provider, articleId, charCount)
    saveNow()
    return limitCheck
  } catch (err) {
    console.error(`[Translation] 用量预占失败 provider=${provider}, chars=${charCount}:`, err)
    return { ok: false, warn: false, reason: '用量预占失败，为防止超额已暂停云端翻译' }
  }
}

export function isProviderPaused(provider: string): boolean {
  try {
    const db = getDb()
    const row = db.prepare("SELECT status FROM translation_control WHERE provider = ? AND status = 'paused'").get(provider)
    return !!row
  } catch { return false }
}

export function pauseProvider(provider: string, reason: string): void {
  try {
    const db = getDb()
    db.prepare("INSERT OR REPLACE INTO translation_control (provider, status, reason, updated_at) VALUES (?, 'paused', ?, datetime('now'))").run(provider, reason)
    saveNow()
  } catch {}
}

// ── 主翻译入口 ────────────────────────────────────────

export async function translateArticle(input: TranslateInput): Promise<TranslateResult> {
  const charCount = input.title.length + input.abstract.length
  const provider = getSetting('translation_provider', 'aliyun')
  // P0修复: 默认值改为 'false'，与设置页UI一致
  const allowFallback = getSetting('allow_translation_fallback', 'false') === 'true'

  const chain = []
  if (provider === 'aliyun') chain.push({ name: 'aliyun', translate: translateWithAliyun })
  if (provider === 'ollama' || (provider === 'aliyun' && allowFallback)) {
    chain.push({ name: 'ollama', translate: translateWithOllama })
  }

  let failure: TranslationFailedError | undefined
  let unavailableReason = ''
  for (const step of chain) {
    // 每次按当前月份和设置核算额度，自动恢复到期的暂停。
    if (step.name === 'aliyun') {
      const wasPaused = isProviderPaused(step.name)
      const reserve = reserveTranslationUsage(step.name, input.articleId, charCount)
      if (!reserve.ok) {
        unavailableReason = reserve.reason
        if (!wasPaused) pauseProvider(step.name, reserve.reason)
        continue
      }
      if (reserve.warn) {
        console.log(`[Translation] #${input.articleId} ${reserve.reason}`)
        setControlStatus(step.name, 'warning', reserve.reason)
      } else if (wasPaused) {
        setControlStatus(step.name, 'normal', '')
      }
    }

    try {
      console.log(`[Translation] #${input.articleId} ${step.name}...`)
      const result = await step.translate(input)
      result.title_cn = cleanMarkdown(result.title_cn)
      result.abstract_cn = cleanMarkdown(result.abstract_cn)
      if (!result.title_cn || !result.abstract_cn) {
        throw new TranslationFailedError(step.name + ' returned an empty translation')
      }
      console.log(`[Translation] #${input.articleId} ${step.name} ok: ${result.title_cn.slice(0, 30)}`)
      return result
    } catch (e) {
      console.warn(`[Translation] #${input.articleId} ${step.name}: ${String(e)}`)
      if (e instanceof TranslationFailedError) failure = e
      else unavailableReason = String(e)
    }
  }

  throw failure ?? new TranslationUnavailableError(unavailableReason || '所有翻译服务均不可用')
}

