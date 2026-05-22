import { getDb } from './db'

/**
 * 步骤1: CrossRef 标题搜索 → 获取 DOI + 摘要
 */
async function queryCrossRef(title: string, retries = 2): Promise<{ doi: string; abstract: string } | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const url = `https://api.crossref.org/works?query.title=${encodeURIComponent(title)}&rows=3&select=DOI,abstract,type`
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)
      const response = await fetch(url, {
        headers: { 'User-Agent': 'PaperFeedWidget/0.1 (mailto:user@example.com)' },
        signal: controller.signal,
      })
      clearTimeout(timeout)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json() as {
        message: { items: Array<{ DOI?: string; abstract?: string; type?: string }> }
      }
      const items = data.message?.items || []
      const journalItem = items.find(i => i.type === 'journal-article' && i.DOI)
      const best = journalItem || items.find(i => i.DOI)
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
  try {
    const { getDb } = require('./db')
    const db = getDb()
    const row = db.prepare("SELECT value FROM settings WHERE key = 'elsevier_api_key'").get() as { value: string } | undefined
    apiKey = row?.value || ''
  } catch {}
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
        'SELECT title, abstract, extra_doi FROM articles WHERE id = ?'
      ).get(id) as { title: string; abstract: string; extra_doi: string } | undefined

      if (!existing) continue
      if (existing.abstract && existing.extra_doi) continue

      console.log(`[Abstract] #${id}: ${existing.title.slice(0, 50)}...`)

      // 步骤1: CrossRef
      const cr = await queryCrossRef(existing.title)
      if (!cr) continue

      const doi = cr.doi
      let abstract = cr.abstract

      // 步骤2: 如果 CrossRef 没摘要，用 DOI 调 ScienceDirect
      if (!abstract && doi.startsWith('10.1016/')) {
        const sdAbs = await queryScienceDirectDOI(doi)
        if (sdAbs) abstract = sdAbs
      }

      const updates: string[] = []
      const values: string[] = []

      if (abstract && !existing.abstract) {
        updates.push('abstract = ?')
        values.push(abstract)
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
  try { const db = getDb(); const row = db.prepare("SELECT value FROM settings WHERE key='elsevier_api_key'").get() as {value:string}|undefined; apiKey = row?.value || '' } catch {}
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
