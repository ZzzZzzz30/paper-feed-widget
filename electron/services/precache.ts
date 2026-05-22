/**
 * Display-Ready 预缓存：逐篇完成 DOI→摘要→翻译，使文章可流畅推送
 */
import { getDb } from './db'
import { fetchAbstractsForArticles } from './abstract-fetcher'
import { BrowserWindow } from 'electron'
import { translateArticle } from './translation/service'

let running = true

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
    try {
      const result = await translateArticle({ articleId: id, title: cur.title, abstract: cur.abstract })
      db.prepare("UPDATE articles SET title_cn=?,abstract_cn=?,display_status='display_ready' WHERE id=?")
        .run(result.title_cn, result.abstract_cn, id)
      console.log(`[DisplayCache] #${id} display_ready (${result.provider}): ${result.title_cn.slice(0, 30)}`)
      send('article:translated', { articleId: id, titleCn: result.title_cn, abstractCn: result.abstract_cn })
    } catch (err) {
      console.error(`[DisplayCache] #${id} 翻译失败:`, err)
      db.prepare("UPDATE articles SET display_status='failed' WHERE id=?").run(id)
    }
  } else {
    db.prepare("UPDATE articles SET display_status='display_ready' WHERE id=?").run(id)
    console.log(`[DisplayCache] #${id} 已有缓存, display_ready`)
  }
}

async function mainLoop(): Promise<void> {
  const db = getDb()
  while (running) {
    try {
      // 优先处理高 priority 未就绪文章（排除 failed 避免无限重试）
      const article = db.prepare(`
        SELECT id FROM articles
        WHERE display_status IS NULL OR display_status NOT IN ('display_ready','no_abstract','failed')
        ORDER BY priority DESC, publication_date DESC LIMIT 1
      `).get() as { id: number } | undefined

      if (!article) {
        // 低优扫全库（也排除 failed）
        const low = db.prepare(`
          SELECT id FROM articles
          WHERE (display_status IS NULL OR display_status NOT IN ('display_ready','no_abstract','failed'))
          ORDER BY publication_date DESC LIMIT 1
        `).get() as { id: number } | undefined
        if (!low) { await sleep(5000); continue }
        await prepareArticle(low.id)
      } else {
        await prepareArticle(article.id)
      }
    } catch (err) {
      console.error('[DisplayCache] 异常:', err)
      await sleep(5000)
    }
  }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

export function startPrecacheWorkers(): void { console.log('[DisplayCache] 启动'); mainLoop() }
