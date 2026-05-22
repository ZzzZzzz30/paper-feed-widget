import { getDb } from './db'

interface PushQueueItem {
  articleId: number
  title: string
  titleCn: string
  abstract: string
  abstractCn: string
  doi: string
  tldr: string
  innovation: string[]
  journal: string
  year: number
  score: number
}

let pushQueue: PushQueueItem[] = []

export function generatePushQueue(): PushQueueItem[] {
  const db = getDb()

  const pushCountRow = db.prepare(
    "SELECT value FROM settings WHERE key = 'push_count'"
  ).get() as { value: string } | undefined
  const maxPush = parseInt(pushCountRow?.value || '20', 10)

  const baseSQL = `
    SELECT id, title, abstract, title_cn, abstract_cn, extra_doi, journal, year
    FROM articles a
    WHERE a.display_status = 'display_ready'
      AND a.title_cn IS NOT NULL AND a.title_cn != ''
      AND a.abstract IS NOT NULL AND length(a.abstract) > 50
      AND NOT EXISTS (SELECT 1 FROM interactions i WHERE i.article_id = a.id AND i.action IN ('bookmark','dislike','skip'))
  `

  // CEUS 文章：取 maxPush 篇
  const ceusArticles = db.prepare(
    baseSQL + "AND a.journal = 'Computers, Environment and Urban Systems' ORDER BY a.publication_date DESC LIMIT ?"
  ).all(maxPush) as ArticleRow[]

  // 其他期刊：取 maxPush 篇
  const otherArticles = db.prepare(
    baseSQL + "AND a.journal != 'Computers, Environment and Urban Systems' ORDER BY a.publication_date DESC LIMIT ?"
  ).all(maxPush) as ArticleRow[]

  // 交错排列：1 CEUS + 2 其他，使 CEUS 约占 1/3
  const result: ArticleRow[] = []
  let ci = 0, oi = 0
  while (result.length < maxPush && (ci < ceusArticles.length || oi < otherArticles.length)) {
    if (ci < ceusArticles.length) { result.push(ceusArticles[ci]); ci++ }
    if (oi < otherArticles.length && result.length < maxPush) { result.push(otherArticles[oi]); oi++ }
    if (oi < otherArticles.length && result.length < maxPush) { result.push(otherArticles[oi]); oi++ }
  }

  const toItem = (a: ArticleRow): PushQueueItem => ({
    articleId: a.id,
    title: a.title,
    titleCn: a.title_cn || '',
    abstract: a.abstract || '',
    abstractCn: a.abstract_cn || '',
    doi: a.extra_doi || '',
    tldr: '',
    innovation: [],
    journal: a.journal,
    year: a.year,
    score: 0,
  })

  pushQueue = result.map(toItem)
  return pushQueue
}

type ArticleRow = {
  id: number; title: string; abstract: string | null
  title_cn: string | null; abstract_cn: string | null
  extra_doi: string | null; journal: string; year: number
}

export function popFromQueue(): PushQueueItem | null {
  return pushQueue.shift() || null
}

export function getQueueSize(): number {
  return pushQueue.length
}

export function getQueue(): PushQueueItem[] {
  return [...pushQueue]
}
