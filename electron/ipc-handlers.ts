import { ipcMain, BrowserWindow, shell } from 'electron'
import { spawn } from 'child_process'
import fs from 'fs'
import { getDb, saveNow } from './services/db'
import { fetchAllJournals } from './services/fetcher'
import { fetchAbstractsForArticles } from './services/abstract-fetcher'
import { generatePushQueue, getQueueSize } from './services/push-manager'
import { quickSummary, chat } from './services/analysis/analysis-service'
import { getTranslationUsage, getSetting, getIntSetting, getFloatSetting } from './services/translation/service'
import { checkTencentOpenStatus } from './services/translation/tencent-translator'
import { toggleAnalysisBubble, closeAnalysisBubble } from './analysis-bubble-window'
import { getOrCreateSession } from './services/analysis/analysis-service'

function getFirefoxPath(): string | null {
  if (process.platform !== 'win32') return null
  const candidates = [
    process.env.PROGRAMFILES ? `${process.env.PROGRAMFILES}\\Mozilla Firefox\\firefox.exe` : '',
    process.env['PROGRAMFILES(X86)'] ? `${process.env['PROGRAMFILES(X86)']}\\Mozilla Firefox\\firefox.exe` : '',
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Mozilla Firefox\\firefox.exe` : '',
  ].filter(Boolean)
  return candidates.find(p => fs.existsSync(p)) || null
}

function spawnFirefox(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const firefoxPath = getFirefoxPath()
    const command = firefoxPath || 'firefox'
    console.log('[open:external-url] command =', command)
    const child = spawn(command, [url], { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('spawn', () => { child.unref(); resolve() })
    child.once('error', reject)
  })
}

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  const db = getDb()

  ipcMain.handle('articles:get', async (_e, params: { status?: string; limit?: number; offset?: number }) => {
    const limit = params.limit || 20
    const offset = params.offset || 0
    if (params.status === 'bookmarked') {
      return db.prepare(`SELECT DISTINCT a.* FROM articles a JOIN interactions i ON a.id = i.article_id WHERE i.action = 'bookmark' ORDER BY i.timestamp DESC LIMIT ? OFFSET ?`).all(limit, offset)
    }
    return db.prepare('SELECT * FROM articles ORDER BY publication_date DESC LIMIT ? OFFSET ?').all(limit, offset)
  })

  ipcMain.handle('interaction:record', async (_e, { articleId, action }: { articleId: number; action: string }) => {
    // 防止重复收藏
    if (action === 'bookmark') {
      const already = db.prepare("SELECT id FROM interactions WHERE article_id = ? AND action = 'bookmark'").get(articleId)
      if (already) return
    }
    db.prepare('INSERT INTO interactions (article_id, action) VALUES (?, ?)').run(articleId, action)
    db.prepare('UPDATE articles SET is_pushed = 1, push_count = push_count + 1 WHERE id = ?').run(articleId)
    saveNow()
    return { ok: true }
  })

  ipcMain.handle('bookmark:remove', async (_e, articleId: number) => {
    db.prepare("DELETE FROM interactions WHERE rowid = (SELECT MAX(rowid) FROM interactions WHERE article_id = ? AND action = 'bookmark')").run(articleId)
    return true
  })

  ipcMain.handle('article:mark-read', async (_e, articleId: number) => {
    db.prepare("INSERT INTO interactions (article_id, action) VALUES (?, 'read')").run(articleId)
    saveNow()
    return { ok: true }
  })

  ipcMain.handle('article:mark-unread', async (_e, articleId: number) => {
    db.prepare("DELETE FROM interactions WHERE article_id = ? AND action = 'read'").run(articleId)
    saveNow()
    return { ok: true }
  })

  ipcMain.handle('article:get-read-ids', async () => {
    const rows = db.prepare("SELECT article_id FROM interactions WHERE action = 'read'").all() as Array<{ article_id: number }>
    return rows.map(r => r.article_id)
  })

  ipcMain.handle('push:save-state', async (_e, payload: { ids: number[]; index: number }) => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('push_saved_ids', ?)").run(JSON.stringify(payload.ids))
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('push_saved_index', ?)").run(String(payload.index))
    saveNow()
    return { ok: true }
  })

  ipcMain.handle('push:load-state', async () => {
    const idsRow = db.prepare("SELECT value FROM settings WHERE key = 'push_saved_ids'").get() as { value?: string } | undefined
    const idxRow = db.prepare("SELECT value FROM settings WHERE key = 'push_saved_index'").get() as { value?: string } | undefined
    if (!idsRow?.value) return null
    try {
      return { ids: JSON.parse(idsRow.value) as number[], index: parseInt(idxRow?.value || '0', 10) }
    } catch { return null }
  })

  ipcMain.handle('push:get-blocked-ids', async () => {
    const rows = db.prepare("SELECT DISTINCT article_id FROM interactions WHERE action IN ('bookmark','dislike','skip')").all() as Array<{ article_id: number }>
    return rows.map(r => r.article_id)
  })

  ipcMain.handle('settings:get', async () => {
    const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
    const settings: Record<string, string> = {}
    for (const row of rows) settings[row.key] = row.value
    console.log('[Settings] getSettings → font_size =', settings.font_size, 'font_family =', settings.font_family)
    return settings
  })

  ipcMain.handle('settings:update', async (_e, { key, value }: { key: string; value: string }) => {
    console.log(`[Settings] update ${key} = ${value}`)
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
    try {
      saveNow()
      console.log('[Settings] 保存成功')
    } catch (err) {
      console.error('[Settings] 保存失败:', err)
      throw new Error('设置保存失败')
    }
    return { ok: true }
  })

  let pushPromise: Promise<ReturnType<typeof generatePushQueue>> | null = null

  ipcMain.handle('push:request', async () => {
    if (pushPromise) return pushPromise

    pushPromise = (async () => {
      const newCount = await fetchAllJournals()
      if (newCount === 0 && getQueueSize() === 0) {
        await fetchAllJournals(true)
      }
      const queue = generatePushQueue()
      if (queue.length > 0) {
        const firstId = queue[0].articleId
        try {
          await Promise.race([
            fetchAbstractsForArticles([firstId]),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15_000)),
          ])
          const enriched = db.prepare('SELECT abstract, extra_doi FROM articles WHERE id = ?').get(firstId) as { abstract: string; extra_doi: string } | undefined
          if (enriched) {
            queue[0] = { ...queue[0], abstract: enriched.abstract || queue[0].abstract, doi: enriched.extra_doi || queue[0].doi }
          }
        } catch { /* timeout */ }
        if (queue.length > 1) {
          fetchAbstractsForArticles(queue.slice(1, 10).map(item => item.articleId))
        }
      }
      return queue
    })()

    const result = await pushPromise
    pushPromise = null

    // 优先级分层
    if (result.length > 0) {
      const totalReady = db.prepare("SELECT COUNT(*) as c FROM articles WHERE display_status='display_ready'").get() as {c:number}
      console.log(`[Push] ready=${totalReady.c} 返回${result.length}篇`)
      const setPri = (ids: number[], pri: number) => {
        if (ids.length === 0) return
        db.prepare(`UPDATE articles SET priority=${pri} WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)
      }
      setPri(result.slice(0, 1).map(i => i.articleId), 1000)
      setPri(result.slice(1, 6).map(i => i.articleId), 800)
      setPri(result.slice(6, 21).map(i => i.articleId), 500)
    }
    return result
  })

  ipcMain.handle('article:enrich', async (_e, articleId: number) => {
    await fetchAbstractsForArticles([articleId])
    return db.prepare('SELECT abstract, extra_doi FROM articles WHERE id = ?').get(articleId) || null
  })

  ipcMain.handle('push:queueSize', async () => getQueueSize())

  ipcMain.handle('push:more', async (_e, excludeIds: number[]) => {
    const excludeSet = new Set(excludeIds || [])
    const placeholders = excludeSet.size > 0 ? `AND a.id NOT IN (${[...excludeSet].map(() => '?').join(',')})` : ''
    const queue = db.prepare(`
      SELECT a.id, a.title, a.abstract, a.title_cn, a.abstract_cn, a.extra_doi, a.journal, a.year
      FROM articles a
      WHERE a.display_status='display_ready'
      AND a.title_cn IS NOT NULL AND a.title_cn != ''
      AND NOT EXISTS (SELECT 1 FROM interactions i WHERE i.article_id = a.id AND i.action IN ('bookmark','dislike','skip'))
      ${placeholders}
      ORDER BY a.publication_date DESC
      LIMIT 20
    `).all(...(excludeSet.size > 0 ? [...excludeSet] : [])) as Array<{
      id:number;title:string;abstract:string;title_cn:string;abstract_cn:string;extra_doi:string;journal:string;year:number
    }>
    return queue.map(a => ({
      articleId: a.id, title: a.title, titleCn: a.title_cn || '', abstract: a.abstract || '',
      abstractCn: a.abstract_cn || '', doi: a.extra_doi || '', tldr: '', innovation: [],
      journal: a.journal, year: a.year, score: 0,
    }))
  })

  ipcMain.handle('article:translate', async (_e, articleId: number) => {
    const cached = db.prepare('SELECT title_cn, abstract_cn FROM articles WHERE id = ?').get(articleId) as { title_cn: string; abstract_cn: string } | undefined
    if (cached?.title_cn) return cached
    // 提优先级让后台 Worker 尽快处理
    db.prepare('UPDATE articles SET priority=1000 WHERE id=?').run(articleId)
    return null
  })

  ipcMain.handle('window:minimize', () => mainWindow.minimize())
  ipcMain.handle('window:close', () => mainWindow.hide())
  ipcMain.handle('window:toggleOnTop', () => {
    mainWindow.setAlwaysOnTop(!mainWindow.isAlwaysOnTop())
  })

  ipcMain.handle('article:quick-summary', async (_e, articleId: number) => {
    try { return await quickSummary(articleId) } catch (e) { return '分析失败: ' + String(e) }
  })
  ipcMain.handle('analysis:chat', async (_e, { articleId, sessionId, message }: { articleId: number; sessionId: number | null; message: string }) => {
    try { return await chat(articleId, sessionId, message) } catch (e) { return { sessionId: sessionId || 0, reply: '对话失败: ' + String(e) } }
  })

  ipcMain.handle('analysis-bubble:toggle', async (_e, payload: { articleId: number; articleTitle: string }) => {
    toggleAnalysisBubble(mainWindow, payload)
    return true
  })

  ipcMain.handle('analysis:get-session', async (_e, articleId: number) => {
    return getOrCreateSession(articleId)
  })

  ipcMain.handle('analysis-bubble:close', async () => {
    closeAnalysisBubble()
    return true
  })

  ipcMain.handle('deepseek:usage', async () => {
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(cost_usd), 0) as cost_usd
      FROM ai_usage
      WHERE provider = 'deepseek'
    `).get() as { input_tokens: number; output_tokens: number; total_tokens: number; cost_usd: number }
    return {
      input: row.input_tokens || 0,
      output: row.output_tokens || 0,
      total: row.total_tokens || 0,
      cost: row.cost_usd || 0,
    }
  })

  ipcMain.handle('translation:usage', async () => {
    return getTranslationUsage()
  })

  ipcMain.handle('translation:quota-overview', async () => {
    try {
    const usage = getTranslationUsage()
    const provider = getSetting('translation_provider', 'tencent')
    const fallback = getSetting('allow_translation_fallback', 'false') === 'true'
    const now = new Date()
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`

    function buildQuota(p: string, name: string) {
      const limitWan = getIntSetting(`${p}_char_limit`, p === 'tencent' ? 500 : 100)
      const initialWan = getIntSetting(`${p}_initial_used_chars`, 0)
      const warnRatio = getFloatSetting(`${p}_warn_ratio`, 0.8)
      const stopRatio = getFloatSetting(`${p}_stop_ratio`, 0.9)
      const localChars = p === 'tencent' ? usage.tencentChars : usage.aliyunChars
      const limitChars = limitWan * 10000
      const initialChars = initialWan * 10000
      const usedChars = initialChars + localChars

      const warnAt = limitWan > 0 ? Math.floor(limitChars * warnRatio) : 0
      const stopAt = limitWan > 0 ? Math.floor(limitChars * stopRatio) : 0
      const percent = limitWan > 0 ? usedChars / limitChars : null
      const pctText = percent !== null ? (percent * 100).toFixed(1) + '%' : '不限'

      let status = 'normal', reason = ''
      if (!usage.ok) { status = 'error'; reason = usage.error || '' }
      else if (limitWan > 0) {
        const ctrl = db.prepare('SELECT status, reason FROM translation_control WHERE provider = ?').get(p) as { status?: string; reason?: string } | undefined
        if (ctrl?.status === 'paused') { status = 'paused'; reason = ctrl.reason || '' }
        else if (ctrl?.status === 'warning') { status = 'warning'; reason = ctrl.reason || '' }
        else if (percent !== null && percent >= stopRatio) { status = 'paused'; reason = `已达到 ${Math.round(percent*100)}% 限额` }
        else if (percent !== null && percent >= warnRatio) { status = 'warning'; reason = `已使用 ${Math.round(percent*100)}% 限额` }
      }

      // Cloud status (only tencent has it via DescribeOpenStatus)
      const cloud: { available: boolean; hasOpen?: boolean; hasArrearage?: boolean; usageNote?: string } = { available: false }
      if (p === 'tencent') {
        cloud.available = true
        cloud.usageNote = '腾讯云云端调用量查询暂不可用，当前使用本地统计防超额'
      } else {
        cloud.available = false
        cloud.usageNote = '阿里云云端报表待接入'
      }

      return {
        provider: p, displayName: name,
        limitWan, limitChars, initialUsedWan: initialWan, initialUsedChars: initialChars,
        localMonthChars: localChars, usedChars,
        warnRatio, stopRatio, warnAtChars: warnAt, stopAtChars: stopAt,
        percent, percentText: pctText,
        remainingToWarn: limitWan > 0 ? Math.max(0, warnAt - usedChars) : null,
        remainingToStop: limitWan > 0 ? Math.max(0, stopAt - usedChars) : null,
        remainingToLimit: limitWan > 0 ? Math.max(0, limitChars - usedChars) : null,
        status, reason, cloudStatus: cloud,
      }
    }

    // Global status
    const tStatus = buildQuota('tencent', '腾讯云机器翻译').status
    const aStatus = buildQuota('aliyun', '阿里云机器翻译').status
    const globalStatus = !usage.ok ? 'error'
      : (tStatus === 'paused' && aStatus === 'paused') ? 'paused'
      : (tStatus === 'paused' || aStatus === 'paused' || tStatus === 'warning' || aStatus === 'warning') ? 'warning'
      : 'normal'

    return {
      monthStart, monthLabel: `${now.getFullYear()}年${now.getMonth() + 1}月`,
      globalStatus, activeProvider: provider, allowFallback: fallback,
      localUsageOk: usage.ok, localUsageError: usage.error,
      providers: {
        tencent: buildQuota('tencent', '腾讯云机器翻译'),
        aliyun: buildQuota('aliyun', '阿里云机器翻译'),
      },
    }
    } catch (e) {
      console.error('[quota-overview] 异常:', e)
      return { ok: false, error: String(e) }
    }
  })

  ipcMain.handle('translation:recover', async (_e, provider: string) => {
    if (!['tencent', 'aliyun'].includes(provider)) throw new Error('invalid provider')
    db.prepare("DELETE FROM translation_control WHERE provider = ?").run(provider)
    saveNow()
    return { ok: true }
  })

  ipcMain.handle('translation:reset-stats', async (_e, provider: string) => {
    if (!['tencent', 'aliyun'].includes(provider)) throw new Error('invalid provider')
    const monthStart = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`
    db.prepare("DELETE FROM translation_usage WHERE provider = ? AND created_at >= ?").run(provider, monthStart)
    saveNow()
    return { ok: true }
  })

  ipcMain.handle('translation:cloud-status', async () => {
    const status: Record<string, unknown> = { tencent: null, aliyun: null }
    try { status.tencent = await checkTencentOpenStatus() } catch (e) { status.tencent = { error: String(e) } }
    return status
  })

  ipcMain.handle('open:external-url', async (_e, rawUrl: string) => {
    const url = new URL(rawUrl.trim())
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`Unsupported URL protocol: ${url.protocol}`)
    }
    const urlStr = url.toString()
    console.log('[open:external-url] received:', urlStr)

    try {
      await spawnFirefox(urlStr)
      return { ok: true, browser: 'firefox' }
    } catch (err) {
      console.error('[open:external-url] Firefox 启动失败，回退到系统默认浏览器:', err)
      await shell.openExternal(urlStr)
      console.log('[open:external-url] fallback shell.openExternal')
      return { ok: true, browser: 'default' }
    }
  })
}
