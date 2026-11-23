import { normalizePushKeywords, readPushKeywords } from './services/push-keywords'
import { ipcMain, BrowserWindow, shell } from 'electron'
import { setWidgetCompact, setWorkspaceExpanded, resizeSurface, dragIsland, isIslandHovered, setWindowMaterial } from './window'
import { spawn } from 'child_process'
import fs from 'fs'
import { getDb, saveNow } from './services/db'
import { fetchAllJournals } from './services/fetcher'
import { getConferenceOptions, saveConferenceOptions, syncConferences } from './services/conference-fetcher'
import { getConfiguredMinYear, isEligiblePublicationYear } from './services/publication-policy'
import { fetchAbstractsForArticles } from './services/abstract-fetcher'
import { generatePushQueue, getQueueSize, selectPushItems } from './services/push-manager'
import { quickSummary, chat } from './services/analysis/analysis-service'
import { getTranslationUsage, getSetting, getIntSetting, getFloatSetting, isProviderPaused } from './services/translation/service'
import { toggleAnalysisBubble, closeAnalysisBubble } from './analysis-bubble-window'
import { getOrCreateSession } from './services/analysis/analysis-service'
import { discoverJournal, type JournalConfig } from './services/journal-discovery'
import { getSettingsForRenderer, hasSecretSetting, isSecretSetting, writeSettingValue } from './services/secure-settings'

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
  const currentMonthKey = () => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  }

  ipcMain.handle('articles:statistics', () => {
    const yearRow = db.prepare("SELECT value FROM settings WHERE key='year_from'").get() as { value?: string } | undefined
    const minYear = getConfiguredMinYear(yearRow?.value)
    const conferences = getConferenceOptions()
    const names = new Map(conferences.map(item => [item.id.toLowerCase(), item.name]))
    const rows = db.prepare(`
      SELECT CASE WHEN a.source_type = 'conference' THEN 'conference' ELSE 'journal' END AS type,
        CASE WHEN a.source_type = 'conference' THEN lower(coalesce(nullif(trim(a.conference_id), ''), trim(a.journal))) ELSE lower(trim(a.journal)) END AS statistics_venue_key,
        MIN(a.journal) AS name, COUNT(*) AS total,
        SUM(CASE WHEN coalesce(a.title_cn, '') != '' AND coalesce(a.abstract_cn, '') != '' THEN 1 ELSE 0 END) AS translated,
        SUM(CASE WHEN a.display_status = 'display_ready' AND coalesce(a.title_cn, '') != ''
          AND a.abstract IS NOT NULL AND length(a.abstract) > 50 AND a.year >= ? AND blocked.article_id IS NULL THEN 1 ELSE 0 END) AS available
      FROM articles a
      LEFT JOIN (SELECT DISTINCT article_id FROM interactions WHERE action IN ('bookmark', 'dislike')) blocked ON blocked.article_id = a.id
      GROUP BY type, statistics_venue_key
    `).all(minYear) as Array<{ type: string; statistics_venue_key: string; name: string; total: number; translated: number; available: number }>
    const sources = new Map(rows.map(row => [`${row.type}:${row.statistics_venue_key}`, { name: row.type === 'conference' ? names.get(row.statistics_venue_key) || row.name : row.name, total: row.total, translated: row.translated, available: row.available }]))
    const journalRow = db.prepare("SELECT value FROM settings WHERE key='journals'").get() as { value?: string } | undefined
    try {
      const journals = JSON.parse(journalRow?.value || '[]') as Array<{ name?: string }>
      for (const journal of journals) {
        if (!journal.name) continue
        const key = `journal:${journal.name.trim().toLowerCase()}`
        if (!sources.has(key)) sources.set(key, { name: journal.name, total: 0, translated: 0, available: 0 })
      }
    } catch { /* Ignore invalid saved journal configuration. */ }
    for (const conference of conferences.filter(item => item.enabled)) {
      const key = `conference:${conference.id.toLowerCase()}`
      if (!sources.has(key)) sources.set(key, { name: conference.name, total: 0, translated: 0, available: 0 })
    }
    return { rows: Array.from(sources.values()).sort((a, b) => a.name.localeCompare(b.name)), updatedAt: new Date().toISOString() }
  })

  ipcMain.handle('articles:get', async (_e, params: { status?: string; limit?: number; offset?: number }) => {
    const limit = params.limit || 20
    const offset = params.offset || 0
    const yearRow = db.prepare("SELECT value FROM settings WHERE key='year_from'").get() as { value?: string } | undefined
    const minYear = getConfiguredMinYear(yearRow?.value)
    if (params.status === 'bookmarked') {
      return db.prepare(`SELECT DISTINCT a.* FROM articles a JOIN interactions i ON a.id = i.article_id WHERE i.action = 'bookmark' AND a.year >= ? ORDER BY i.timestamp DESC LIMIT ? OFFSET ?`).all(minYear, limit, offset)
    }
    return db.prepare('SELECT * FROM articles WHERE year >= ? ORDER BY publication_date DESC LIMIT ? OFFSET ?').all(minYear, limit, offset)
  })

  ipcMain.handle('interaction:record', async (_e, { articleId, action }: { articleId: number; action: string }) => {
    if (action !== 'bookmark' && action !== 'dislike') throw new Error('Invalid interaction action')
    // 防止重复收藏
    if (action === 'bookmark') {
      const already = db.prepare("SELECT id FROM interactions WHERE article_id = ? AND action = 'bookmark'").get(articleId)
      if (already) return
    }
    db.prepare('INSERT INTO interactions (article_id, action) VALUES (?, ?)').run(articleId, action)
    db.prepare('UPDATE articles SET is_pushed = 1, push_count = push_count + 1 WHERE id = ?').run(articleId)
    return { ok: true }
  })

  ipcMain.handle('bookmark:remove', async (_e, articleId: number) => {
    db.prepare("DELETE FROM interactions WHERE rowid = (SELECT MAX(rowid) FROM interactions WHERE article_id = ? AND action = 'bookmark')").run(articleId)
    return true
  })

  ipcMain.handle('article:mark-read', async (_e, articleId: number) => {
    db.prepare("INSERT INTO interactions (article_id, action) VALUES (?, 'read')").run(articleId)
    return { ok: true }
  })

  ipcMain.handle('article:mark-unread', async (_e, articleId: number) => {
    db.prepare("DELETE FROM interactions WHERE article_id = ? AND action = 'read'").run(articleId)
    return { ok: true }
  })

  ipcMain.handle('article:get-read-ids', async () => {
    const rows = db.prepare("SELECT article_id FROM interactions WHERE action = 'read'").all() as Array<{ article_id: number }>
    return rows.map(r => r.article_id)
  })

  ipcMain.handle('push:save-state', async (_e, payload: { ids: number[]; index: number }) => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('push_saved_ids', ?)").run(JSON.stringify(payload.ids))
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('push_saved_index', ?)").run(String(payload.index))
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

  ipcMain.handle('journals:get', async () => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'journals'").get() as { value?: string } | undefined
    if (row?.value) {
      try { return JSON.parse(row.value) } catch { /* ignore */ }
    }
    // fallback 到 journals.json
    try {
      const fs = require('fs')
      const path = require('path')
      const p = path.join(__dirname, '..', '..', 'journals.json')
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'))
    } catch {}
    return []
  })

  const validateJournals = (value: unknown): JournalConfig[] => {
    if (!Array.isArray(value) || value.length > 200) throw new Error('期刊列表格式不正确')
    return value.map(item => {
      if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200
        || typeof item.issn !== 'string' || !/^\d{4}-\d{3}[\dX]$/i.test(item.issn)
        || typeof item.rssUrl !== 'string' || (item.rssUrl && !/^https:\/\//i.test(item.rssUrl))) {
        throw new Error('期刊名称、ISSN 或订阅地址不正确')
      }
      return { name: item.name.trim(), issn: item.issn.toUpperCase(), rssUrl: item.rssUrl }
    })
  }

  ipcMain.handle('journals:discover', async (_e, name: unknown) => discoverJournal(name))

  ipcMain.handle('journals:add', async (_e, value: unknown) => {
    const [journal] = validateJournals([value])
    const row = db.prepare("SELECT value FROM settings WHERE key = 'journals'").get() as { value?: string } | undefined
    const journals: JournalConfig[] = row?.value ? validateJournals(JSON.parse(row.value)) : []
    const added = !journals.some(item => item.issn === journal.issn || item.name.toLowerCase() === journal.name.toLowerCase())
    if (added) {
      journals.push(journal)
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('journals', ?)").run(JSON.stringify(journals))
    }
    return { added, journals }
  })

  ipcMain.handle('journals:save', async (_e, value: unknown) => {
    const journals = validateJournals(value)
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('journals', ?)").run(JSON.stringify(journals))
    return { ok: true }
  })

  ipcMain.handle('conferences:get', async () => getConferenceOptions())
  ipcMain.handle('conferences:save', async (_e, value: unknown) => ({ ok: true, conferences: saveConferenceOptions(value) }))
  ipcMain.handle('conferences:sync', async () => syncConferences(true))

  ipcMain.handle('push:get-blocked-ids', async () => {
    const rows = db.prepare("SELECT DISTINCT article_id FROM interactions WHERE action IN ('bookmark','dislike')").all() as Array<{ article_id: number }>
    return rows.map(r => r.article_id)
  })

  ipcMain.handle('settings:get', async () => {
    const settings = getSettingsForRenderer()
    settings.push_keywords = JSON.stringify(readPushKeywords(settings.push_keywords))
    console.log('[Settings] getSettings → font_size =', settings.font_size, 'font_family =', settings.font_family)
    return settings
  })

  ipcMain.handle('settings:update', async (_e, { key, value }: { key: string; value: string }) => {
    try {
      if (key === 'push_keywords') value = JSON.stringify(normalizePushKeywords(JSON.parse(value)))
      if (key === 'year_from') {
        const parsed = Number(value)
        if (!isEligiblePublicationYear(parsed)) throw new Error('出版年份必须为 1–9999 的整数')
        value = String(parsed)
        const previous = db.prepare("SELECT value FROM settings WHERE key='year_from'").get() as { value?: string } | undefined
        if (getConfiguredMinYear(previous?.value) !== parsed) {
          db.prepare('DELETE FROM journal_fetch_state').run()
        }
      }
      if (isSecretSetting(key)) {
        writeSettingValue(key, value)
        saveNow()
      } else {
        writeSettingValue(key, value)
      }
      const initialUsedMatch = key.match(/^(aliyun)_initial_used_chars$/)
      if (initialUsedMatch) {
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(`${initialUsedMatch[1]}_initial_used_month`, currentMonthKey())
      }
    } catch (err) {
      console.error('[Settings] 保存失败:', err)
      throw new Error('设置保存失败')
    }
    return { ok: true, ...(isSecretSetting(key) ? { configured: hasSecretSetting(key) } : {}) }
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
    return selectPushItems(20, Array.isArray(excludeIds) ? excludeIds : [])
  })

  ipcMain.handle('article:translate', async (_e, articleId: number) => {
    const cached = db.prepare('SELECT title_cn, abstract_cn FROM articles WHERE id = ?').get(articleId) as { title_cn: string; abstract_cn: string } | undefined
    if (cached?.title_cn) return cached
    // 提优先级让后台 Worker 尽快处理
    db.prepare('UPDATE articles SET priority=1000 WHERE id=?').run(articleId)
    return null
  })

  ipcMain.handle('window:minimize', () => mainWindow.minimize())
  ipcMain.handle('window:set-compact', (event, compact: boolean, stage: 'prepare' | 'finish', preview = false) => {
    if (event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame || typeof compact !== 'boolean' || !['prepare', 'finish'].includes(stage)) {
      throw new Error('Invalid widget window request')
    }
    return setWidgetCompact(mainWindow, compact, stage, preview === true)
  })
  const authorizeWindow = (event: Electron.IpcMainInvokeEvent) => {
    if (event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid window request')
  }
  ipcMain.handle('window:workspace', (event, expanded: boolean) => {
    authorizeWindow(event)
    if (typeof expanded !== 'boolean') throw new Error('Invalid workspace request')
    setWorkspaceExpanded(mainWindow, expanded)
  })
  ipcMain.handle('window:island-hovered', event => {
    authorizeWindow(event)
    return isIslandHovered(mainWindow)
  })
  ipcMain.handle('window:island-drag', (event, stage: string) => {
    authorizeWindow(event)
    if (!['start', 'move', 'end', 'cancel'].includes(stage)) throw new Error('Invalid drag request')
    return dragIsland(mainWindow, stage)
  })
  ipcMain.handle('window:resize-surface', (event, stage: string, edge: string) => {
    authorizeWindow(event)
    if (!['start', 'end', 'cancel'].includes(stage) || typeof edge !== 'string') throw new Error('Invalid resize request')
    resizeSurface(mainWindow, stage, edge)
  })
  ipcMain.handle('window:material', (event, material: string) => {
    authorizeWindow(event)
    setWindowMaterial(mainWindow, material)
  })
  ipcMain.handle('window:close', () => mainWindow.hide())

  ipcMain.handle('article:quick-summary', async (_e, { articleId, sessionId }: { articleId: number; sessionId?: number | null }) => {
    try { return await quickSummary(articleId, sessionId) } catch (e) { return { sessionId: sessionId || 0, reply: '分析失败: ' + String(e) } }
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
    const provider = getSetting('translation_provider', 'aliyun')
    const fallback = getSetting('allow_translation_fallback', 'false') === 'true'
    const now = new Date()
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`

    function buildQuota(p: string, name: string) {
      const limitWan = getIntSetting(`${p}_char_limit`, 100)
      // initial_used_chars 按月隔离：仅当月设置的值生效
      const savedMonth = getSetting(`${p}_initial_used_month`, '')
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
      const initialWan = savedMonth === currentMonth ? getIntSetting(`${p}_initial_used_chars`, 0) : 0
      const warnRatio = getFloatSetting(`${p}_warn_ratio`, 0.8)
      const stopRatio = getFloatSetting(`${p}_stop_ratio`, 0.9)
      const localChars = usage.aliyunChars
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

      return {
        provider: p, displayName: name,
        limitWan, limitChars, initialUsedWan: initialWan, initialUsedChars: initialChars,
        localMonthChars: localChars, usedChars,
        warnRatio, stopRatio, warnAtChars: warnAt, stopAtChars: stopAt,
        percent, percentText: pctText,
        remainingToWarn: limitWan > 0 ? Math.max(0, warnAt - usedChars) : null,
        remainingToStop: limitWan > 0 ? Math.max(0, stopAt - usedChars) : null,
        remainingToLimit: limitWan > 0 ? Math.max(0, limitChars - usedChars) : null,
        status, reason, cloudStatus: { available: false, usageNote: '本地统计防超额' },
      }
    }

    const aliyun = buildQuota('aliyun', '阿里云机器翻译')
    const globalStatus = !usage.ok ? 'error'
      : provider === 'ollama' ? 'normal'
      : aliyun.status === 'paused' && fallback ? 'warning' : aliyun.status

    return {
      monthStart, monthLabel: `${now.getFullYear()}年${now.getMonth() + 1}月`,
      globalStatus, activeProvider: provider, allowFallback: fallback,
      localUsageOk: usage.ok, localUsageError: usage.error,
      providers: { aliyun },
    }
    } catch (e) {
      console.error('[quota-overview] 异常:', e)
      return { ok: false, error: String(e) }
    }
  })

  ipcMain.handle('translation:recover', async (_e, provider: string) => {
    if (provider !== 'aliyun') throw new Error('invalid provider')
    db.prepare("DELETE FROM translation_control WHERE provider = ?").run(provider)
    saveNow()
    return { ok: true }
  })

  ipcMain.handle('translation:reset-stats', async (_e, provider: string) => {
    if (provider !== 'aliyun') throw new Error('invalid provider')
    const monthStart = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`
    db.prepare("DELETE FROM translation_usage WHERE provider = ? AND created_at >= ?").run(provider, monthStart)
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(`${provider}_initial_used_chars`, '0')
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(`${provider}_initial_used_month`, currentMonthKey())
    db.prepare("DELETE FROM translation_control WHERE provider = ?").run(provider)
    saveNow()
    return { ok: true }
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
