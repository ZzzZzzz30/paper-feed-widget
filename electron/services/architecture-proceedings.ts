import { pathToFileURL } from 'node:url'
import { normalizeArticleTitle } from './article-matching'
import type { ConferencePaper } from './conference-fetcher'
import { getDb } from './db'

type Venue = 'caadria' | 'ecaade'
type ReadPage = (url: string) => Promise<string | null>
type Line = { text: string; y: number; size: number }
type TextItem = { str: string; transform: number[]; width: number; height: number }
const importPdf = new Function('url', 'return import(url)') as (url: string) => Promise<typeof import('pdfjs-dist')>

export async function syncArchitectureProceedings(
  venue: Venue, year: number, readPage: ReadPage, persist: (paper: ConferencePaper) => void,
): Promise<{ errors: string[] }> {
  const errors: string[] = []
  const read = async (url: string) => {
    try { return await readPage(url) || '' }
    catch (error) { errors.push(new URL(url).hostname + ': ' + errorMessage(error)); return '' }
  }
  const volumes = new Map<number, string>()
  const agenda = new Map<string, ConferencePaper>()
  const readAgenda = async (url: string) => {
    for (const paper of parseEcaadeAgenda(await read(url), url, year)) agenda.set(paper.sourceId, paper)
  }

  if (venue === 'ecaade' && year === 2025) {
    const site = 'https://ecaade2025.metu.edu.tr/'
    const days = new Set(links(await read(site), site).map(x => x.url).filter(url =>
      url.origin === new URL(site).origin && /^\/sessions-\d+-september-2025-/.test(url.pathname)).map(url => url.href))
    for (const day of days) await readAgenda(day)
  } else if (venue === 'ecaade' && year === 2026) {
    await readAgenda('https://ecaade2026.eu/schedule-paper-sessions/')
    const page = 'https://ecaade2026.eu/proceedings-of-the-conference/'
    for (const { url } of links(await read(page), page)) {
      const volume = url.pathname.match(/^\/wp-content\/uploads\/\d{4}\/\d{2}\/Volume(\d+)\.pdf$/i)?.[1]
      if (url.hostname === 'ecaade2026.eu' && volume) volumes.set(Number(volume), secureUrl(url))
    }
  }

  const pending = [...agenda.values()].filter(paper => !storedAbstract(venue, paper))
  for (const paper of pending) persist(paper)

  if (venue === 'ecaade' && year === 2025 && agenda.size) {
    let failed = 0
    for (let offset = 0; offset < pending.length; offset += 3) {
      await Promise.all(pending.slice(offset, offset + 3).map(async paper => {
        try {
          let abstract = ''
          await scanPdf(paper.pdfUrl, (_page, lines) => { abstract ||= extractAbstract(lines, true) }, 1)
          if (abstract.length < 50) throw new Error('No recognizable abstract')
          persist({ ...paper, abstract })
        } catch { failed++ }
      }))
    }
    if (!failed && !errors.length) return { errors }
    if (failed) errors.push(failed + ' official preprint(s) could not supply an abstract')
  }

  if (venue === 'caadria' || !volumes.size) {
    const page = venue === 'caadria' ? 'https://caadria.org/downloads/' : 'https://ecaade.org/publications/downloads/'
    const pattern = venue === 'caadria'
      ? new RegExp('^CAADRIA' + year + '_Volume-(\\d+)\\.pdf$', 'i')
      : new RegExp('^eCAADe[-_]?' + year + '[-_]?Volume[-_]?(\\d+)[^/]*\\.pdf$', 'i')
    for (const { url } of links(await read(page), page)) {
      const volume = url.pathname.split('/').at(-1)?.match(pattern)?.[1]
      if (!volume || (venue === 'caadria' ? url.hostname !== 'caadria.org' : !['ecaade.org', 'www.dropbox.com'].includes(url.hostname))) continue
      if (url.hostname === 'www.dropbox.com') url.searchParams.set('dl', '1')
      volumes.set(Number(volume), secureUrl(url))
    }
  }

  if (!volumes.size && !agenda.size) errors.push('No official proceedings found for ' + year)
  const byTitle = new Map([...agenda.values()].map(paper => [normalizeArticleTitle(paper.title), paper]))
  for (const [volume, url] of volumes) {
    const key = ['official_pdf_v1', venue, year, volume, url].join(':')
    if (getDb().prepare('SELECT 1 FROM settings WHERE key=?').get(key)) continue
    try {
      let count = 0
      await scanPdf(url, (page, lines) => {
        const article = parseProceedingsPage(lines, venue)
        if (!article) return
        count++
        const pdfUrl = url + '#page=' + page
        const match = byTitle.get(normalizeArticleTitle(article.title))
        persist(match ? { ...match, abstract: article.abstract, pdfUrl } : {
          ...article, sourceId: ['volume', year, volume, page].join(':'), doi: '',
          publicationDate: String(year), url: pdfUrl, pdfUrl,
        })
      })
      if (!count) throw new Error('No recognizable paper pages')
      getDb().prepare("INSERT OR IGNORE INTO settings(key,value) VALUES (?,'1')").run(key)
    } catch (error) { errors.push('Volume ' + volume + ': ' + errorMessage(error)) }
  }
  return { errors }
}

function storedAbstract(venue: Venue, paper: ConferencePaper): boolean {
  const row = getDb().prepare("SELECT length(trim(abstract)) AS length FROM articles WHERE source_key=? AND source_key!=''")
    .get(venue + ':' + paper.sourceId) as { length?: number } | undefined
  return (row?.length || 0) >= 50
}

export function parseEcaadeAgenda(html: string, page: string, year: number): ConferencePaper[] {
  const papers = new Map<string, ConferencePaper>()
  const pattern = new RegExp('/ecaade' + year + '_(\\d+)(?:\\.pdf)?$', 'i')
  for (const { url, label, index } of links(html, page)) {
    const pdf = url.hostname === 'conf.dap.tuwien.ac.at'
    if (!pdf && url.hostname !== 'papers.cumincad.org') continue
    const id = url.pathname.match(pattern)?.[1]
    if (!id) continue
    const fields = label.split('\n').map(x => x.trim()).filter(Boolean)
    let authors = fields[1] || ''
    let title: string
    if (pdf) {
      const heading = html.lastIndexOf('<h5', index)
      if (heading < 0) continue
      const nearby = html.slice(heading, index).match(/^<h5\b[^>]*>([\s\S]*?)<\/h5>\s*<p\b[^>]*>([\s\S]*?)<\/p>/i)
      if (!nearby) continue
      title = clean(nearby[1]).replace(new RegExp('^' + id + '\\s*[-–—]\\s*'), '')
      authors = clean(nearby[2])
    } else {
      if (fields[0] !== id) continue
      title = fields.slice(2).join(' ')
    }
    if (!title || /^https?:/i.test(title)) continue
    papers.set(id, {
      sourceId: ['agenda', year, id].join(':'), title, authors: splitNames(authors), doi: '', abstract: '',
      publicationDate: String(year), url: secureUrl(url), pdfUrl: pdf ? url.href : '',
    })
  }
  return [...papers.values()]
}

async function scanPdf(url: string, observe: (page: number, lines: Line[]) => void, limit = Infinity): Promise<void> {
  const pdf = await importPdf(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href)
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) })
  const maxBytes = 450 * 1024 * 1024
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel()
    throw new Error('PDF unavailable (HTTP ' + response.status + ')')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > maxBytes) throw new Error('PDF exceeds download limit')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const data = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length }
  chunks.length = 0
  if (!Buffer.from(data.subarray(0, 8)).includes('%PDF-')) throw new Error('Expected an official PDF')
  const task = pdf.getDocument({ data, isEvalSupported: false, verbosity: 0 })
  try {
    const doc = await task.promise
    for (let n = 1; n <= Math.min(doc.numPages, limit); n++) {
      const page = await doc.getPage(n)
      const items = (await page.getTextContent()).items.filter(item => 'str' in item)
      observe(n, pageLines(items))
      page.cleanup()
    }
  } finally {
    await task.destroy()
  }
}

export function pageLines(items: TextItem[]): Line[] {
  const groups = new Map<number, TextItem[]>()
  for (const item of items) {
    if (!item.str.trim()) continue
    const y = Math.round(item.transform[5] * 2) / 2
    const line = groups.get(y) || []
    line.push(item)
    groups.set(y, line)
  }
  return [...groups.entries()].sort(([a], [b]) => b - a).map(([y, items]) => {
    let text = ''
    let end = -Infinity
    for (const item of items.sort((a, b) => a.transform[4] - b.transform[4])) {
      if (text && item.transform[4] - end > item.height * 0.13) text += ' '
      text += item.str
      end = item.transform[4] + item.width
    }
    return { text: text.replace(/\s+/g, ' ').trim(), y, size: Math.max(...items.map(item => item.height)) }
  })
}

export function parseProceedingsPage(lines: Line[], venue: Venue): Pick<ConferencePaper, 'title' | 'authors' | 'abstract'> | null {
  const abstract = extractAbstract(lines, venue === 'ecaade')
  if (abstract.length < 50) return null
  const end = lines.findIndex(line => /^(?:abstract\b|keywords?\s*[.:])/i.test(line.text))
  const first = lines.slice(0, end).filter(line => line.size >= 8 && /[a-z]{3}/i.test(line.text))
  if (!first.length) return null
  const titleLines: Line[] = []
  for (const line of first) {
    if (line.size < first[0].size - 0.35 || (titleLines.length && titleLines.at(-1)!.y - line.y > 32)) break
    titleLines.push(line)
  }
  if (!titleLines.length || titleLines.length > 5 || first.length <= titleLines.length) return null
  const title = titleLines.map(line => line.text).join(' ')
  if (title.length < 12 || title.length > 300 || /^(?:contents|foreword|preface)\b/i.test(title)) return null
  // Author superscripts vary between volumes. Use the official agenda names when available.
  return { title, authors: [], abstract }
}

export function extractAbstract(lines: Line[], allowUnlabelled: boolean): string {
  const start = lines.findIndex(line => /^abstract\b\s*[:.]?/i.test(line.text))
  if (start >= 0) {
    const end = lines.findIndex((line, i) => i > start && /^(?:keywords?\b|(?:1\.?\s+)?introduction\b)/i.test(line.text))
    if (end <= start) return ''
    return [lines[start].text.replace(/^abstract\b\s*[:.]?\s*/i, ''), ...lines.slice(start + 1, end).map(line => line.text)].join(' ').trim()
  }
  if (!allowUnlabelled) return ''
  const end = lines.findIndex(line => /^keywords?\s*[.:]/i.test(line.text))
  if (end < 1) return ''
  let begin = end - 1
  while (begin > 0 && lines[begin - 1].y - lines[begin].y <= lines[begin].size * 1.6) begin--
  return lines.slice(begin, end).map(line => line.text).join(' ').trim()
}

function links(html: string, base: string) {
  return [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].flatMap(match => {
    try { return [{ url: new URL(decode(match[1]), base), label: clean(match[2]), index: match.index ?? 0 }] }
    catch { return [] }
  })
}

function decode(s: string) {
  return s.replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ').replace(/&#(\d+);/g, (_m, n) => {
    const code = Number(n)
    return code <= 0x10ffff ? String.fromCodePoint(code) : ''
  }).replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
}
function clean(s: string) {
  return decode(s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?[^>]+>/g, ''))
    .split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
}
function splitNames(s: string): string[] { return s.split(/\s*,\s*|\s+and\s+/i).filter(Boolean) }
function secureUrl(url: URL): string { url.protocol = 'https:'; return url.href }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
