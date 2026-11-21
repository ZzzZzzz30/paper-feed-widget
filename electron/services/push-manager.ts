import { getDb } from './db'
import { getConfiguredMinYear } from './publication-policy'

interface PushQueueItem {
  articleId: number
  title: string
  titleCn: string
  abstract: string
  abstractCn: string
  doi: string
  url: string
  tldr: string
  innovation: string[]
  journal: string
  year: number
  score: number
}

let pushQueue: PushQueueItem[] = []

export const sourceKey = `CASE WHEN a.source_type = 'conference'
  THEN 'conference:' || lower(coalesce(nullif(trim(a.conference_id), ''), trim(a.journal)))
  ELSE 'journal:' || lower(trim(a.journal))
END`

const pushKeywords = [
  /\bllm\b/i,
  /\bllms\b/i,
  /\bllm[\s\p{Pd}]+agents?\b/iu,
  /\bagentic\b/i,
  /\bai[\s\p{Pd}]+agents?\b/iu,
  /\bbim\b/i,
  /\bifc\b/i,
  /\bifcopenshell\b/i,
  /\brevit\b/i,
  /\bbuilding\s+information\s+modeling\b/i,
]

function keywordScore(title: string, abstract: string): number {
  const text = (title + '\n.\n' + abstract).normalize('NFKC').replace(/<[^>]*>/g, ' ')
  // Split joined names such as MultiAgent or AgentBench before looking for the agent term.
  const agentText = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
  const agent = /\b(?:multi|single|sub|co|micro|meta|super)?agents?(?:based|driven|powered|enabled|oriented|assisted|guided|centric)?\b/i.test(agentText)
  return pushKeywords.filter(keyword => keyword.test(text)).length + Number(agent)
}

export function generatePushQueue(): PushQueueItem[] {
  const db = getDb()

  const pushCountRow = db.prepare(
    "SELECT value FROM settings WHERE key = 'push_count'"
  ).get() as { value: string } | undefined
  const maxPush = parseInt(pushCountRow?.value || '20', 10)
  pushQueue = selectPushItems(maxPush)
  return pushQueue
}

export function selectPushItems(limit: number, excludeIds: number[] = []): PushQueueItem[] {
  const db = getDb()
  const yearRow = db.prepare("SELECT value FROM settings WHERE key='year_from'").get() as { value?: string } | undefined
  const minYear = getConfiguredMinYear(yearRow?.value)

  const tailId = excludeIds[excludeIds.length - 1]
  const tail = tailId === undefined ? undefined : db.prepare(
    `SELECT ${sourceKey} AS venue_key FROM articles a WHERE a.id = ?`
  ).get(tailId) as { venue_key: string } | undefined
  const candidates = db.prepare(`
    SELECT a.id, a.title, a.abstract, ${sourceKey} AS venue_key
    FROM articles a
    WHERE a.display_status = 'display_ready'
      AND a.title_cn IS NOT NULL AND a.title_cn != ''
      AND a.abstract IS NOT NULL AND length(a.abstract) > 50
      AND a.year >= ?
      AND NOT EXISTS (SELECT 1 FROM interactions i WHERE i.article_id = a.id AND i.action IN ('bookmark','dislike'))
      AND a.id NOT IN (SELECT value FROM json_each(?) WHERE type = 'integer')
    ORDER BY a.id
  `).all(minYear, JSON.stringify(excludeIds)) as Array<{ id: number; title: string; abstract: string; venue_key: string }>

  const sourceRanks = new Map<string, number>()
  const ranked = candidates.map(({ id, title, abstract, venue_key }) => {
    const score = keywordScore(title, abstract)
    const group = score + ':' + venue_key
    const rank = (sourceRanks.get(group) ?? 0) + 1
    sourceRanks.set(group, rank)
    return { id, score, rank, venue: venue_key, afterWrap: Number(venue_key <= (tail?.venue_key ?? '')) }
  })
  ranked.sort((a, b) => b.score - a.score || a.rank - b.rank || a.afterWrap - b.afterWrap
    || (a.venue < b.venue ? -1 : a.venue > b.venue ? 1 : 0))

  const selected = ranked.slice(0, Number.isSafeInteger(limit) && limit > 0 ? limit : 20)
  if (!selected.length) return []
  const scores = new Map(selected.map(({ id, score }) => [id, score]))
  const result = db.prepare(`
    SELECT a.id, a.title, a.abstract, a.title_cn, a.abstract_cn, a.extra_doi, a.journal, a.year, a.url, a.pdf_url
    FROM json_each(?) chosen JOIN articles a ON a.id = chosen.value
    ORDER BY chosen.key
  `).all(JSON.stringify(selected.map(({ id }) => id))) as ArticleRow[]

  return result.map(a => ({
    articleId: a.id,
    title: a.title,
    titleCn: a.title_cn || '',
    abstract: a.abstract || '',
    abstractCn: a.abstract_cn || '',
    doi: a.extra_doi || '',
    url: a.pdf_url || a.url || '',
    tldr: '',
    innovation: [],
    journal: a.journal,
    year: a.year,
    score: scores.get(a.id) ?? 0,
  }))
}

type ArticleRow = {
  id: number; title: string; abstract: string | null
  title_cn: string | null; abstract_cn: string | null
  extra_doi: string | null; journal: string; year: number
  url: string | null; pdf_url: string | null
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
