import { getDb } from './db'
import { readSecretSetting } from './secure-settings'
import { findExactJournalArticle, normalizeDoi, type CrossRefArticleCandidate } from './article-matching'

/**
 * 步骤1: CrossRef 标题搜索 → 获取 DOI + 摘要
 */
async function queryCrossRef(title: string, issn: string, year: number, doi?: string, type: 'journal-article' | 'proceedings-article' = 'journal-article', retries = 2): Promise<{ doi: string; abstract: string } | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (!issn && !doi && type !== 'proceedings-article') return null
      const url = doi
        ? `https://api.crossref.org/works/${encodeURIComponent(doi)}`
        : `https://api.crossref.org/works?query.title=${encodeURIComponent(title)}&filter=${issn ? `issn:${encodeURIComponent(issn)},` : ''}type:${type}&rows=10&select=DOI,title,abstract,type,ISSN,published,published-print,published-online`
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)
      const response = await fetch(url, {
        headers: { 'User-Agent': 'PaperFeedWidget/0.1 (mailto:user@example.com)' },
        signal: controller.signal,
      })
      clearTimeout(timeout)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json() as {
        message: CrossRefArticleCandidate | { items?: CrossRefArticleCandidate[] }
      }
      const message = data.message
      const items = Array.isArray((message as { items?: CrossRefArticleCandidate[] })?.items)
        ? (message as { items: CrossRefArticleCandidate[] }).items
        : message ? [message as CrossRefArticleCandidate] : []
      const best = findExactJournalArticle(title, items, { issn: issn || undefined, year: year || undefined, doi, type })
      if (!best?.DOI) return null
      return { doi: best.DOI, abstract: best.abstract || '' }
    } catch (err) {
      if (attempt < retries) {
        console.log(`[Abstract] CrossRef重试 ${attempt + 1}/${retries}...`)
        await new Promise(r => setTimeout(r, 2000))
      } else {
        console.error(`[Abstract] CrossRef失败: ${err}`)
      }
    }
  }
  return null
}

/**
 * 步骤2: ScienceDirect API 用 DOI 获取摘要
 */
async function queryScienceDirectDOI(doi: string): Promise<string | null> {
  // 从 DB 或环境变量读取 API Key
  let apiKey = ''
  try { apiKey = readSecretSetting('elsevier_api_key') } catch {}
  if (!apiKey) apiKey = process.env.ELSEVIER_API_KEY || ''
  if (!apiKey) return null
  try {
    const url = `https://api.elsevier.com/content/article/doi/${encodeURIComponent(doi)}`
    const response = await fetch(url, {
      headers: { 'X-ELS-APIKey': apiKey, 'Accept': 'application/json' },
    })
    if (!response.ok) return null
    const data = await response.json() as {
      'full-text-retrieval-response'?: { coredata?: { 'dc:description'?: string; 'prism:doi'?: string } }
    }
    return data?.['full-text-retrieval-response']?.coredata?.['dc:description'] || null
  } catch {
    return null
  }
}

/**
 * 补充指定文章的摘要/DOI
 * 策略: CrossRef(拿DOI+摘要) → ScienceDirect DOI API(补充摘要)
 */
export async function fetchAbstractsForArticles(articleIds: number[]): Promise<number> {
  const db = getDb()
  let fetched = 0

  for (const id of articleIds) {
    try {
      const existing = db.prepare(
        'SELECT title, abstract, extra_doi, issn, year, source_type FROM articles WHERE id = ?'
      ).get(id) as { title: string; abstract: string; extra_doi: string; issn: string; year: number; source_type: string } | undefined

      if (!existing) continue
      const knownDoi = normalizeDoi(existing.extra_doi)
      const abstractLength = (existing.abstract || '').trim().length
      if (abstractLength >= 50 && knownDoi) continue

      console.log(`[Abstract] #${id}: ${existing.title.slice(0, 50)}...`)

      // 步骤1: CrossRef
      const type = existing.source_type === 'conference' ? 'proceedings-article' : 'journal-article'
      const cr = await queryCrossRef(existing.title, existing.issn, existing.year, knownDoi || undefined, type)

      const doi = knownDoi || cr?.doi || ''
      if (!doi) continue
      let abstract = cr?.abstract || ''

      // A DOI already verified at ingest can be used even when Crossref is unavailable.
      if (abstractLength < 50 && abstract.trim().length < 50 && doi.startsWith('10.1016/')) {
        const sdAbs = await queryScienceDirectDOI(doi)
        if (sdAbs && sdAbs.trim().length > abstract.trim().length) abstract = sdAbs
      }

      const updates: string[] = []
      const values: string[] = []

      if (abstractLength < 50 && abstract.trim().length > abstractLength) {
        updates.push('abstract = ?')
        values.push(abstract)
        if (abstract.trim().length >= 50) {
          updates.push("display_status = CASE WHEN display_status IN ('no_abstract','failed') THEN NULL ELSE display_status END")
        }
        console.log(`[Abstract] #${id} 摘要: ${abstract.slice(0, 60)}...`)
      }
      if (doi && !existing.extra_doi) {
        updates.push('extra_doi = ?')
        values.push(doi)
        console.log(`[Abstract] #${id} DOI: ${doi}`)
      }

      // 步骤3: 用 DOI 获取 Graphical Abstract
      const gaUrl = doi ? await fetchGraphicalAbstract(doi) : null
      if (gaUrl) {
        updates.push('graphical_abstract_url = ?')
        values.push(gaUrl)
        console.log(`[Abstract] #${id} GA: 已获取`)
      }

      if (updates.length > 0) {
        values.push(String(id))
        db.prepare(`UPDATE articles SET ${updates.join(', ')} WHERE id = ?`).run(...values)
        fetched++
      }
    } catch (err) {
      console.error(`[Abstract] #${id} 异常:`, err)
    }
    await new Promise(r => setTimeout(r, 100))
  }

  return fetched
}

/**
 * 通过 DOI 获取 Graphical Abstract URL
 */
async function fetchGraphicalAbstract(doi: string): Promise<string | null> {
  let apiKey = ''
  try { apiKey = readSecretSetting('elsevier_api_key') } catch {}
  if (!apiKey) apiKey = process.env.ELSEVIER_API_KEY || ''
  if (!apiKey) return null
  if (!doi.startsWith('10.1016/')) return null // 非 Elsevier 文章

  try {
    const url = `https://api.elsevier.com/content/article/doi/${encodeURIComponent(doi)}`
    const response = await fetch(url, {
      headers: { 'X-ELS-APIKey': apiKey, 'Accept': 'application/json' },
    })
    if (!response.ok) return null
    const data = await response.json() as {
      'full-text-retrieval-response'?: {
        attachment?: Array<{ 'attachment-type'?: string; '$'?: { href?: string } }>
      }
    }
    const attachments = data?.['full-text-retrieval-response']?.attachment || []
    const ga = attachments.find(a => a['attachment-type'] === 'graphical-abstract')
    return ga?.$?.href || null
  } catch {
    return null
  }
}

export async function fetchMissingAbstracts(count = 5): Promise<void> {
  const db = getDb()
  const articles = db.prepare(`
    SELECT id FROM articles
    WHERE abstract IS NULL OR abstract = '' OR extra_doi IS NULL OR extra_doi = ''
    LIMIT ?
  `).all(count) as Array<{ id: number }>
  if (articles.length === 0) { console.log('[Abstract] 无需补充'); return }
  console.log(`[Abstract] 后台补充 ${articles.length} 篇...`)
  const ids = articles.map(a => a.id)
  const fetched = await fetchAbstractsForArticles(ids)
  console.log(`[Abstract] 完成 ${fetched}/${articles.length} 篇`)
}
