import { getDb } from './db'
import { parseRSSFeed } from './rss-parser'
import cron from 'node-cron'
import fs from 'fs'
import path from 'path'

interface JournalConfig {
  name: string
  issn: string
  rssUrl: string
}

function loadJournals(): JournalConfig[] {
  // 优先从 settings 表读取用户自定义期刊
  try {
    const db = getDb()
    const row = db.prepare("SELECT value FROM settings WHERE key = 'journals'").get() as { value?: string } | undefined
    if (row?.value) {
      const data = JSON.parse(row.value)
      if (Array.isArray(data) && data.length > 0) return data
    }
  } catch {}

  // 其次从 journals.json 读取
  const configPath = path.join(__dirname, '..', '..', 'journals.json')
  try {
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      if (Array.isArray(data) && data.length > 0) return data
    }
  } catch (e) { console.error('[Fetcher] journals.json 读取失败') }

  // fallback 默认期刊
  return [
    { name: 'Computers, Environment and Urban Systems', issn: '0198-9715', rssUrl: 'https://rss.sciencedirect.com/publication/science/01989715' },
    { name: 'Cities', issn: '0264-2751', rssUrl: 'https://rss.sciencedirect.com/publication/science/02642751' },
    { name: 'Landscape and Urban Planning', issn: '0169-2046', rssUrl: 'https://rss.sciencedirect.com/publication/science/01692046' },
    { name: 'Habitat International', issn: '0197-3975', rssUrl: 'https://rss.sciencedirect.com/publication/science/01973975' },
    { name: 'Applied Geography', issn: '0143-6228', rssUrl: 'https://rss.sciencedirect.com/publication/science/01436228' },
  ]
}

const JOURNALS: JournalConfig[] = loadJournals()

let lastFetchTime = 0
const FETCH_THROTTLE_MS = 5 * 60 * 1000

export function startScheduler(): void {
  cron.schedule('0 */6 * * *', async () => {
    console.log('[Fetcher] 定时抓取触发')
    await fetchAllJournals(true)
  })
}

export async function fetchAllJournals(force = false): Promise<number> {
  const now = Date.now()
  if (!force && (now - lastFetchTime) < FETCH_THROTTLE_MS) {
    console.log('[Fetcher] 跳过（距上次抓取不足5分钟）')
    return 0
  }
  lastFetchTime = now
  const db = getDb()
  const yearFrom = db.prepare("SELECT value FROM settings WHERE key = 'year_from'").get() as { value: string } | undefined
  const minYear = parseInt(yearFrom?.value || '2015', 10)

  let totalNew = 0

  for (const journal of JOURNALS) {
    try {
      // 1. RSS 获取最新文章
      const rssArticles = await fetchJournalArticlesFromRSS(journal, minYear)
      let rssNew = 0
      for (const article of rssArticles) {
        const result = upsertArticle(db, article, journal)
        if (result === 'inserted') rssNew++
      }
      console.log(`[Fetcher] RSS ${journal.name}: ${rssArticles.length} 篇, 新增 ${rssNew}`)

      // 2. CrossRef 分页抓取（深入旧文章）
      const crossrefNew = await fetchFromCrossRefPaginated(journal, minYear)
      console.log(`[Fetcher] CrossRef ${journal.name}: 新增 ${crossrefNew}`)

      totalNew += rssNew + crossrefNew
    } catch (err) {
      console.error(`[Fetcher] 抓取失败 ${journal.name}:`, err)
    }
  }

  console.log(`[Fetcher] 本轮总计新增 ${totalNew} 篇文章`)
  return totalNew
}

// ── CrossRef 分页抓取 ──────────────────────────────────────

async function fetchFromCrossRefPaginated(
  journal: JournalConfig,
  minYear: number
): Promise<number> {
  const db = getDb()

  // 获取或初始化抓取状态
  let state = db.prepare(
    'SELECT next_offset, page_size FROM journal_fetch_state WHERE journal = ?'
  ).get(journal.name) as { next_offset: number; page_size: number } | undefined

  if (!state) {
    db.prepare(
      'INSERT INTO journal_fetch_state (journal, issn, next_offset, page_size) VALUES (?, ?, 0, 25)'
    ).run(journal.name, journal.issn)
    state = { next_offset: 0, page_size: 25 }
  }

  const offset = state.next_offset
  const count = state.page_size

  const crossrefUrl =
    `https://api.crossref.org/works` +
    `?filter=issn:${journal.issn},from-pub-date:${minYear},type:journal-article` +
    `&rows=${count}&offset=${offset}&sort=published&order=desc` +
    `&select=DOI,title,abstract,author,published-print,link`

  let data: CrossRefResponse
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    const resp = await fetch(crossrefUrl, {
      headers: {
        'User-Agent': 'PaperFeedWidget/0.2 (mailto:user@example.com)',
        'Accept': 'application/json',
      },
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!resp.ok) {
      console.error(`[CrossRef] HTTP ${resp.status} for ${journal.name}`)
      return 0
    }
    data = await resp.json() as CrossRefResponse
  } catch (err) {
    console.error(`[CrossRef] 请求失败 ${journal.name}:`, err)
    return 0
  }

  const items = data.message?.items || []
  if (items.length === 0) {
    // 没有更多结果，重置 offset 以便后续重新扫描
    db.prepare(
      "UPDATE journal_fetch_state SET next_offset=0, last_fetch_at=datetime('now') WHERE journal=?"
    ).run(journal.name)
    return 0
  }

  let inserted = 0
  for (const item of items) {
    if (!item.DOI || !item.title) continue
    const pubYear = item['published-print']?.['date-parts']?.[0]?.[0]
      || item.published?.['date-parts']?.[0]?.[0]
      || 0
    if (pubYear < minYear) continue

    const authorString = item.author
      ? JSON.stringify(item.author.map((a: CrossRefAuthor) => `${a.given || ''} ${a.family || ''}`.trim()))
      : '[]'

    const articleUrl = item.link?.[0]?.URL || item.URL || ''

    // 先用 DOI 查重
    const existingByDOI = db.prepare('SELECT id FROM articles WHERE extra_doi = ?').get(item.DOI)
    if (existingByDOI) continue

    const raw: RawArticle = {
      doi: item.DOI, // 用 DOI 作为主键
      title: String(item.title).trim(),
      abstract: item.abstract || '',
      authors: authorString,
      year: pubYear,
      publicationDate: item['published-print']?.['date-parts']?.[0]
        ? `${pubYear}-${String(item['published-print']!['date-parts']![0][1] || 1).padStart(2, '0')}-${String(item['published-print']!['date-parts']![0][2] || 1).padStart(2, '0')}`
        : String(pubYear),
      url: articleUrl,
      pdfUrl: '',
      graphicalAbstractUrl: '',
    }

    const result = upsertArticle(db, raw, journal)
    if (result === 'inserted') {
      // 同时写入 extra_doi
      try {
        db.prepare('UPDATE articles SET extra_doi=? WHERE doi=?').run(item.DOI, item.DOI)
      } catch { /* ok */ }
      inserted++
    }
  }

  // 更新抓取进度
  const newOffset = offset + count
  db.prepare(
    "UPDATE journal_fetch_state SET next_offset=?, last_fetch_at=datetime('now') WHERE journal=?"
  ).run(newOffset, journal.name)

  console.log(`[FetchMore] journal=${journal.name} offset=${offset} count=${count} inserted=${inserted} duplicated=${items.length - inserted}`)

  return inserted
}

interface CrossRefResponse {
  message?: {
    items?: CrossRefWork[]
    'total-results'?: number
  }
}

interface CrossRefWork {
  DOI?: string
  title?: string | string[]
  abstract?: string
  author?: CrossRefAuthor[]
  'published-print'?: { 'date-parts'?: number[][] }
  published?: { 'date-parts'?: number[][] }
  link?: Array<{ URL: string }>
  URL?: string
}

interface CrossRefAuthor {
  given?: string
  family?: string
}

// ── RSS 抓取（保留原有逻辑）────────────────────────────────

async function fetchJournalArticlesFromRSS(
  journal: JournalConfig,
  minYear: number
): Promise<RawArticle[]> {
  const rssItems = await parseRSSFeed(journal.rssUrl)

  const articles: RawArticle[] = []
  const unresolvedItems: RSSItemForLookup[] = []

  for (const item of rssItems) {
    const parsed = parseRSSItem(item)

    if (!parsed.title || isNonArticle(parsed.title)) continue

    const uniqueId = parsed.pii || parsed.url || ''
    if (!uniqueId) continue

    const year = extractYear(parsed.description)
    if (year && year < minYear) continue

    articles.push({
      doi: uniqueId,
      title: parsed.title,
      abstract: '',
      authors: parsed.authors || '[]',
      year: year || 0,
      publicationDate: toISODate(parsed.pubDate),
      url: parsed.url || '',
      pdfUrl: '',
      graphicalAbstractUrl: '',
      description: parsed.description || '',
    })

    unresolvedItems.push({
      title: parsed.title,
      issn: journal.issn,
      uniqueId,
    })
  }

  // 异步补充 CrossRef 元数据
  if (unresolvedItems.length > 0) {
    enrichArticlesFromCrossRef(unresolvedItems, articles)
  }

  return articles
}

interface RSSItemForLookup {
  title: string
  issn: string
  uniqueId: string
}

function enrichArticlesFromCrossRef(
  unresolvedItems: RSSItemForLookup[],
  articles: RawArticle[]
): void {
  resolveDOIsByTitle(unresolvedItems).then(doiMap => {
    const db = getDb()
    for (const article of articles) {
      const resolved = doiMap.get(article.doi)
      if (!resolved) continue

      const updates: Record<string, string | number> = {}
      if (resolved.abstract) {
        updates.abstract = resolved.abstract
      }
      if (resolved.year && resolved.year !== article.year) {
        updates.year = resolved.year
      }
      if (resolved.authorString) {
        updates.authors = resolved.authorString
      }

      if (Object.keys(updates).length > 0) {
        const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ')
        const values = Object.values(updates)
        db.prepare(`UPDATE articles SET ${setClauses} WHERE doi = ?`).run(
          ...values,
          article.doi
        )
      }
    }
  }).catch(err => {
    console.error('[Fetcher] CrossRef 后台补充失败:', err)
  })
}

async function resolveDOIsByTitle(
  items: RSSItemForLookup[]
): Promise<Map<string, { realDoi?: string; abstract?: string; year?: number; authorString?: string }>> {
  const result = new Map<string, { realDoi?: string; abstract?: string; year?: number; authorString?: string }>()

  for (const item of items) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10_000)

      const searchUrl = `https://api.crossref.org/works?query.title=${encodeURIComponent(item.title)}&filter=issn:${item.issn}&rows=1&select=DOI,title,abstract,author,published`
      const response = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'PaperFeedWidget/0.2 (mailto:user@example.com)',
          'Accept': 'application/json',
        },
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (!response.ok) continue

      const data = await response.json() as {
        message: {
          items: Array<{
            DOI?: string
            abstract?: string
            published?: { 'date-parts'?: number[][] }
            author?: Array<{ given?: string; family?: string }>
          }>
        }
      }

      const match = data.message?.items?.[0]
      if (match) {
        result.set(item.uniqueId, {
          realDoi: match.DOI,
          abstract: match.abstract || '',
          year: match.published?.['date-parts']?.[0]?.[0],
          authorString: JSON.stringify(
            (match.author || []).map(a => `${a.given || ''} ${a.family || ''}`.trim())
          ),
        })
      }
    } catch {
      // 单个失败不影响整体
    }

    await new Promise(resolve => setTimeout(resolve, 100))
  }

  return result
}

// ── RSS 解析 ──────────────────────────────────────────────

interface ParsedRSSItem {
  title: string
  url: string
  pii: string | null
  description: string
  authors: string | null
  pubDate: string
}

function parseRSSItem(item: { title: string; link: string; content?: string; description?: string; creator?: string; pubDate?: string }): ParsedRSSItem {
  const title = (item.title || '').trim()
  const url = (item.link || '').trim()
  const body = (item.content || item.description || '').trim()

  const piiMatch = url.match(/pii\/([A-Z]?\d{14,20}[A-Z]?)/i)
  const pii = piiMatch ? piiMatch[1] : null

  let authors: string | null = item.creator || null
  if (!authors && body) {
    const authorMatch = body.match(/Author\(s\):\s*(.+?)<\/p>/i)
    if (authorMatch) {
      authors = JSON.stringify(
        authorMatch[1]
          .split(/,|\band\b/)
          .map(a => a.trim())
          .filter(Boolean)
      )
    }
  }

  let pubDate = item.pubDate || ''
  if (!pubDate && body) {
    const dateMatch = body.match(/Publication date:\s*(.+?)<\/p>/i)
    if (dateMatch) {
      pubDate = dateMatch[1].trim()
    }
  }

  return { title, url, pii, description: body, authors, pubDate }
}

function toISODate(raw: string): string {
  if (!raw) return ''
  const monthYear = raw.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i)
  if (monthYear) {
    const months: Record<string, string> = {
      january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',
      july:'07',august:'08',september:'09',october:'10',november:'11',december:'12'
    }
    const m = months[monthYear[1].toLowerCase()]
    return `${monthYear[2]}-${m}-01`
  }
  const fullDate = raw.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i)
  if (fullDate) {
    const months: Record<string, string> = {
      january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',
      july:'07',august:'08',september:'09',october:'10',november:'11',december:'12'
    }
    const m = months[fullDate[2].toLowerCase()]
    const d = fullDate[1].padStart(2, '0')
    return `${fullDate[3]}-${m}-${d}`
  }
  return raw
}

function extractYear(description: string): number | null {
  const dateMatch = description.match(/Publication date:\s*.+?(\d{4})/i)
  if (dateMatch) return parseInt(dateMatch[1], 10)
  const onlineMatch = description.match(/Available online\s*.+?(\d{4})/i)
  if (onlineMatch) return parseInt(onlineMatch[1], 10)
  return null
}

function isNonArticle(title: string): boolean {
  const skipPatterns = [
    /^Editorial Board$/i,
    /^Corrigendum/i,
    /^Erratum/i,
    /^Retraction/i,
    /^Withdrawal/i,
    /^Inside front cover/i,
    /^Outside back cover/i,
    /^Contents\s*list/i,
  ]
  return skipPatterns.some(p => p.test(title))
}

// ── 文章插入 ──────────────────────────────────────────────

interface RawArticle {
  doi: string
  title: string
  abstract?: string
  authors?: string
  year?: number
  publicationDate?: string
  url?: string
  pdfUrl?: string
  graphicalAbstractUrl?: string
  description?: string
}

function upsertArticle(
  db: ReturnType<typeof getDb>,
  article: RawArticle,
  journal: JournalConfig
): 'inserted' | 'existing' {
  const existing = db.prepare('SELECT id FROM articles WHERE doi = ?').get(article.doi)
  if (existing) return 'existing'

  db.prepare(`
    INSERT INTO articles (doi, title, abstract, authors, journal, issn, publication_date, year, url, pdf_url, graphical_abstract_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    article.doi,
    article.title,
    article.abstract || '',
    article.authors || '[]',
    journal.name,
    journal.issn,
    article.publicationDate || '',
    article.year || 0,
    article.url || '',
    article.pdfUrl || '',
    article.graphicalAbstractUrl || ''
  )

  return 'inserted'
}
