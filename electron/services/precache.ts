/**
 * Display-Ready 预缓存：逐篇完成 DOI→摘要→翻译，使文章可流畅推送
 */
import { getDb } from './db'
import { fetchAbstractsForArticles } from './abstract-fetcher'
import { BrowserWindow } from 'electron'
import { translateArticle } from './translation/service'
import { TranslateResult, TranslationFailedError, TranslationUnavailableError } from './translation/types'
import { MIN_PUBLICATION_YEAR } from './publication-policy'
import { sourceKey } from './push-manager'

let running = true
const TRANSLATION_RETRY_INTERVAL_MS = 5 * 60 * 60 * 1000

function send(msg: string, data: Record<string, unknown>): void {
  const wins = BrowserWindow.getAllWindows()
  if (wins.length > 0) wins[0].webContents.send(msg, data)
}

async function prepareArticle(id: number): Promise<void> {
  const db = getDb()
  const a = db.prepare('SELECT id,title,abstract,title_cn,abstract_cn,extra_doi FROM articles WHERE id=?').get(id) as {
    id:number;title:string;abstract:string;title_cn:string;abstract_cn:string;extra_doi:string
  } | undefined
  if (!a) return

  // Step 1: 补 DOI + 摘要
  if (!a.abstract || a.abstract.length < 50 || !a.extra_doi) {
    console.log(`[DisplayCache] #${id} 补元数据...`)
    db.prepare("UPDATE articles SET display_status='metadata' WHERE id=?").run(id)
    await fetchAbstractsForArticles([id])
    const u = db.prepare('SELECT abstract,extra_doi FROM articles WHERE id=?').get(id) as {abstract:string;extra_doi:string}|undefined
    if (u?.abstract || u?.extra_doi) {
      send('article:metadata-updated', { articleId: id, abstract: u.abstract || '', doi: u.extra_doi || '' })
    }
  }

  // Step 2: 翻译
  const cur = db.prepare('SELECT title,abstract,title_cn FROM articles WHERE id=?').get(id) as {
    title:string;abstract:string;title_cn:string
  } | undefined
  if (!cur?.abstract || cur.abstract.length < 50) {
    db.prepare("UPDATE articles SET display_status='no_abstract' WHERE id=?").run(id)
    return
  }
  if (!cur.title_cn) {
    console.log(`[DisplayCache] #${id} 翻译...`)
    db.prepare("UPDATE articles SET display_status='translating' WHERE id=?").run(id)
    let result: TranslateResult
    try {
      result = await translateArticle({ articleId: id, title: cur.title, abstract: cur.abstract })
    } catch (err) {
      if (!(err instanceof TranslationFailedError)) {
        db.prepare("UPDATE articles SET display_status=NULL WHERE id=?").run(id)
        throw err
      }
      console.error(`[DisplayCache] #${id} 翻译失败:`, err)
      db.prepare("UPDATE articles SET display_status='failed' WHERE id=?").run(id)
      return
    }
    db.prepare("UPDATE articles SET title_cn=?,abstract_cn=?,display_status='display_ready' WHERE id=?")
      .run(result.title_cn, result.abstract_cn, id)
    console.log(`[DisplayCache] #${id} display_ready (${result.provider}): ${result.title_cn.slice(0, 30)}`)
    send('article:translated', { articleId: id, titleCn: result.title_cn, abstractCn: result.abstract_cn })
  } else {
    db.prepare("UPDATE articles SET display_status='display_ready' WHERE id=?").run(id)
    console.log(`[DisplayCache] #${id} 已有缓存, display_ready`)
  }
}

async function mainLoop(): Promise<void> {
  const db = getDb()
  let lastSource = ''
  while (running) {
    try {
      const article = db.prepare(`
        SELECT a.id, ${sourceKey} AS venue_key FROM articles a
        WHERE a.year >= ? AND (a.display_status IS NULL OR a.display_status NOT IN ('display_ready','no_abstract','failed'))
        ORDER BY CASE WHEN venue_key <= ? THEN 1 ELSE 0 END, venue_key, a.id
        LIMIT 1
      `).get(MIN_PUBLICATION_YEAR, lastSource) as { id: number; venue_key: string } | undefined
      if (!article) { await sleep(5000); continue }
      await prepareArticle(article.id)
      lastSource = article.venue_key
    } catch (err) {
      if (err instanceof TranslationUnavailableError) {
        console.warn('[DisplayCache] 暂无可用翻译服务，5 小时后重试:', err.message)
        await sleep(TRANSLATION_RETRY_INTERVAL_MS)
        continue
      }
      console.error('[DisplayCache] 异常:', err)
      await sleep(5000)
    }
  }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

export function startPrecacheWorkers(): void { console.log('[DisplayCache] 启动'); mainLoop() }
