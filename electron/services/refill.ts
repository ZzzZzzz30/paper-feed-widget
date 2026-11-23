import { getDb } from './db'
import { getConfiguredMinYear } from './publication-policy'
import { fetchAllJournals } from './fetcher'

let running = true

async function loop(): Promise<void> {
  const db = getDb()
  while (running) {
    try {
      const yearSetting = db.prepare("SELECT value FROM settings WHERE key='year_from'").get() as { value?: string } | undefined
      const minYear = getConfiguredMinYear(yearSetting?.value)
      const ready = db.prepare(`
        SELECT COUNT(*) as c FROM articles a
        WHERE a.display_status='display_ready' AND a.year >= ?
        AND a.id NOT IN (SELECT article_id FROM blacklist WHERE article_id IS NOT NULL)
        AND a.id NOT IN (SELECT article_id FROM interactions WHERE action='bookmark')
        AND a.id NOT IN (SELECT article_id FROM interactions WHERE action='dislike')
      `).get(minYear) as { c: number }

      const remaining = db.prepare(`
        SELECT COUNT(*) as c FROM articles a
        WHERE a.year >= ? AND a.id NOT IN (SELECT article_id FROM blacklist WHERE article_id IS NOT NULL)
        AND a.id NOT IN (SELECT article_id FROM interactions WHERE action='bookmark')
        AND a.id NOT IN (SELECT article_id FROM interactions WHERE action='dislike')
      `).get(minYear) as { c: number }

      console.log(`[Refill] ready=${ready.c} remaining=${remaining.c}`)

      if (ready.c < 30 || remaining.c < 100) {
        console.log(`[Refill] 触发抓取...`)
        await fetchAllJournals(true)
        const after = db.prepare('SELECT COUNT(*) as c FROM articles').get() as { c: number }
        console.log(`[Refill] 库内${after.c}篇`)
      }
    } catch (err) { console.error('[Refill]', err) }
    await sleep(60_000)
  }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

export function startRefillWorker(): void { console.log('[Refill] 启动'); loop() }
