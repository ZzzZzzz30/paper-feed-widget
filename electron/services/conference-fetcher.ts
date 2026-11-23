import cron from 'node-cron'
import { getDb } from './db'
import { syncArchitectureProceedings } from './architecture-proceedings'
import { normalizeArticleTitle, normalizeDoi } from './article-matching'
import { isEligiblePublicationYear, getConfiguredMinYear } from './publication-policy'

export interface ConferenceConfig {
  id: string
  name: string
  enabled: boolean
}

export interface ConferenceSyncResult {
  inserted: number
  errors: string[]
}

interface ConferenceSource {
  id: string
  name: string
  aliases: string[]
  cadence: 'annual' | 'odd' | 'even'
}

export interface ConferencePaper {
  sourceId: string
  doi: string
  title: string
  abstract: string
  authors: string[]
  publicationDate: string
  url: string
  pdfUrl: string
}

const SOURCES: ConferenceSource[] = [
  { id: 'caadria', name: 'CAADRIA', aliases: ['CAADRIA', 'Computer-Aided Architectural Design Research in Asia'], cadence: 'annual' },
  { id: 'ecaade', name: 'eCAADe', aliases: ['eCAADe', 'Education and Research in Computer Aided Architectural Design in Europe'], cadence: 'annual' },
  { id: 'cvpr', name: 'CVPR', aliases: ['CVPR', 'Computer Vision and Pattern Recognition'], cadence: 'annual' },
  { id: 'iccv', name: 'ICCV', aliases: ['ICCV', 'International Conference on Computer Vision'], cadence: 'odd' },
  { id: 'eccv', name: 'ECCV', aliases: ['ECCV', 'European Conference on Computer Vision'], cadence: 'even' },
  { id: 'neurips', name: 'NeurIPS', aliases: ['NeurIPS', 'Advances in Neural Information Processing Systems'], cadence: 'annual' },
  { id: 'iclr', name: 'ICLR', aliases: ['ICLR', 'International Conference on Learning Representations'], cadence: 'annual' },
]

const MIN_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000
const OLDER_YEAR_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000
let activeRun: Promise<ConferenceSyncResult> | null = null

export function getConferenceOptions(): ConferenceConfig[] {
  const db = getDb()
  const row = db.prepare("SELECT value FROM settings WHERE key='conferences'").get() as { value?: string } | undefined
  const selected = new Map<string, boolean>()
  try {
    const parsed = JSON.parse(row?.value || '[]') as Array<{ id?: string; enabled?: boolean }>
    for (const item of parsed) if (typeof item?.id === 'string') selected.set(item.id, item.enabled !== false)
  } catch {}
  return SOURCES.map(({ id, name }) => ({ id, name, enabled: selected.get(id) ?? false }))
}

export function saveConferenceOptions(value: unknown): ConferenceConfig[] {
  if (!Array.isArray(value)) throw new Error('会议列表格式不正确')
  const requested = new Map<string, boolean>()
  for (const item of value as Array<{ id?: unknown; enabled?: unknown }>) {
    if (typeof item?.id !== 'string' || !SOURCES.some(source => source.id === item.id) || typeof item.enabled !== 'boolean') {
      throw new Error('会议配置包含无效项目')
    }
    requested.set(item.id, item.enabled)
  }
  const normalized = SOURCES.map(({ id, name }) => ({ id, name, enabled: requested.get(id) ?? false }))
  getDb().prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('conferences',?)").run(JSON.stringify(normalized))
  return normalized
}

export function startConferenceScheduler(): void {
  void syncConferences(true)
  cron.schedule('0 */6 * * *', () => { void syncConferences() })
}

export function syncConferences(force = false): Promise<ConferenceSyncResult> {
  if (activeRun) return activeRun
  activeRun = runConferenceSync(force).finally(() => { activeRun = null })
  return activeRun
}

async function runConferenceSync(force: boolean): Promise<ConferenceSyncResult> {
  let inserted = 0
  const syncErrors: string[] = []
  const enabled = new Set(getConferenceOptions().filter(item => item.enabled).map(item => item.id))
  const yearSetting = getDb().prepare("SELECT value FROM settings WHERE key='year_from'").get() as { value?: string } | undefined
  const minYear = getConfiguredMinYear(yearSetting?.value)
  const currentYear = new Date().getFullYear()
  for (const source of SOURCES) {
    if (!enabled.has(source.id)) continue
    for (let year = currentYear; year >= minYear; year--) {
      if (!hasEdition(source, year)) continue
      const state = getDb().prepare(
        'SELECT last_success_at,last_error FROM conference_fetch_state WHERE conference_id=? AND publication_year=?'
      ).get(source.id, year) as { last_success_at?: string; last_error?: string } | undefined
      const checkedAt = state?.last_success_at ? Date.parse(`${state.last_success_at.replace(' ', 'T')}Z`) : 0
      const interval = year === currentYear ? MIN_POLL_INTERVAL_MS : OLDER_YEAR_POLL_INTERVAL_MS
      if (!force && !state?.last_error && checkedAt && Date.now() - checkedAt < interval) continue

      try {
        let fetched = 0
        const { errors: sourceErrors } = await fetchConferenceYear(source, year, paper => {
          if (!isEligiblePublicationYear(publicationYear(paper.publicationDate), minYear)) return
          fetched++
          if (upsertConferencePaper(source, year, paper)) inserted++
        })
        getDb().prepare(`
          INSERT OR REPLACE INTO conference_fetch_state(conference_id,publication_year,last_success_at,last_error)
          VALUES (?, ?, CASE WHEN ?='' THEN datetime('now') ELSE COALESCE((SELECT last_success_at FROM conference_fetch_state WHERE conference_id=? AND publication_year=?), '') END, ?)
        `).run(source.id, year, sourceErrors.length ? sourceErrors.join('; ').slice(0, 500) : '', source.id, year, sourceErrors.join('; ').slice(0, 500))
        if (sourceErrors.length) syncErrors.push(`${source.name} ${year}: ${sourceErrors.join('; ')}`)
        console.log(`[ConferenceFetcher] ${source.name} ${year}: fetched=${fetched}, failed_sources=${sourceErrors.length}`)
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
        getDb().prepare(`
          INSERT OR REPLACE INTO conference_fetch_state(conference_id,publication_year,last_success_at,last_error)
          VALUES (?, ?, COALESCE((SELECT last_success_at FROM conference_fetch_state WHERE conference_id=? AND publication_year=?), ''), ?)
        `).run(source.id, year, source.id, year, message)
        syncErrors.push(`${source.name} ${year}: ${message}`)
        console.error(`[ConferenceFetcher] ${source.name} ${year} failed: ${message}`)
      }
    }
  }
  console.log(`[ConferenceFetcher] sync complete, inserted=${inserted}`)
  return { inserted, errors: syncErrors }
}

function hasEdition(source: ConferenceSource, year: number): boolean {
  if (source.cadence === 'odd') return year % 2 === 1
  if (source.cadence === 'even') return year % 2 === 0
  return true
}

async function fetchConferenceYear(
  source: ConferenceSource,
  year: number,
  persist: (paper: ConferencePaper) => void,
): Promise<{ errors: string[] }> {
  if (source.id === 'iclr') return syncIclrYear(year, persist)
  if (source.id === 'caadria' || source.id === 'ecaade') {
    return syncArchitectureProceedings(source.id, year, getText, persist)
  }
  const cvf = source.id === 'cvpr' || source.id === 'iccv'
  const cvfErrors: string[] = []
  const adapters: Array<[string, () => Promise<ConferencePaper[]>]> = []
  if (cvf) adapters.push(['CVF', () => fetchCvf(source, year, persist, cvfErrors)])
  if (source.id === 'eccv') adapters.push(['ECVA', () => fetchEcva(source, year)])
  if (source.id === 'neurips') adapters.push(['NeurIPS', () => fetchNeuripsIndex(year)])
  adapters.push(['Crossref', () => fetchCrossref(source, year)], ['OpenAlex', () => fetchOpenAlex(source, year)])
  const results = await Promise.all(adapters.map(async ([name, run]) => {
    try { return { records: await run(), error: '' } }
    catch (error) { return { records: [] as ConferencePaper[], error: `${name}: ${error instanceof Error ? error.message : String(error)}` } }
  }))
  const records = mergePaperSources(results.flatMap(result => result.records))
  for (const paper of records) {
    if (isEligiblePublicationYear(publicationYear(paper.publicationDate))) persist(paper)
  }
  const detailSource = source.id === 'neurips' ? 'neurips:'
    : source.id === 'cvpr' || source.id === 'iccv' ? `${source.id}:${year}:`
      : source.id === 'eccv' ? `eccv:${year}:` : ''
  if (detailSource) {
    const detailRecords = cvf ? mergePaperSources([...records, ...pendingCvfDetails(source, year)]) : records
    const missingAbstracts = detailRecords.filter(paper => paper.sourceId.startsWith(detailSource)
      && paper.abstract.trim().length < 50 && !hasStoredAbstract(source, paper))
    const details = await hydrateConferenceDetails(missingAbstracts, paper => {
      if (source.id === 'cvpr' || source.id === 'iccv') return parseCvfDetail(paper.html, paper.base)
      if (source.id === 'eccv') return parseEcvaDetail(paper.html, paper.base)
      return parseNeuripsDetail(paper.html, paper.base)
    })
    const bySourceId = new Map(records.map(paper => [paper.sourceId, paper]))
    for (const detail of details.records) {
      const current = bySourceId.get(detail.sourceId)
      if (current) mergePaperFields(current, detail)
      else records.push(detail)
      if (isEligiblePublicationYear(publicationYear(detail.publicationDate))) persist(detail)
    }
    if (details.failed > 0) results.push({ records: [], error: `${source.name}: ${details.failed} paper detail request(s) failed` })
  }
  return { errors: [...cvfErrors, ...results.map(result => result.error).filter(Boolean)] }
}

function hasStoredAbstract(source: Pick<ConferenceSource, 'id'>, paper: ConferencePaper): boolean {
  const db = getDb()
  const doi = normalizeDoi(paper.doi)
  const row = (doi ? db.prepare(
    'SELECT abstract FROM articles WHERE doi=? OR lower(extra_doi)=? LIMIT 1'
  ).get(doi, doi) as { abstract?: string } | undefined : undefined)
    || db.prepare("SELECT abstract FROM articles WHERE source_key=? AND source_key!=''").get(
      (source.id + ':' + paper.sourceId).slice(0, 900)
    ) as { abstract?: string } | undefined
  return (row?.abstract || '').trim().length >= 50
}

async function getText(url: string, attempts = 3): Promise<string | null> {
  const retryable = new Set([408, 425, 429, 500, 502, 503, 504])
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'PaperFeedWidget/0.3 (conference metadata reader)', Accept: 'text/html, application/json' },
        signal: AbortSignal.timeout(20_000),
      })
      if (response.status === 404 || response.status === 410) return null
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} from ${new URL(url).host}`)
        if (!retryable.has(response.status) || attempt === attempts - 1) throw error
      } else {
        return await response.text()
      }
    } catch (error) {
      if (attempt === attempts - 1 || (error instanceof Error && /^HTTP \d+/.test(error.message) && !/HTTP (408|425|429|500|502|503|504)/.test(error.message))) {
        throw error
      }
    }
    await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)))
  }
  return null
}

async function fetchCvf(
  source: ConferenceSource, year: number, persist: (paper: ConferencePaper) => void, errors: string[],
): Promise<ConferencePaper[]> {
  const indexUrl = `https://openaccess.thecvf.com/${source.id.toUpperCase()}${year}`
  const db = getDb()
  type DayState = { day: string; last_error: string | null }
  const readDays = () => db.prepare(
    'SELECT day,last_error FROM cvf_directory_day WHERE conference_id=? AND publication_year=? ORDER BY day',
  ).all(source.id, year) as unknown as DayState[]

  const previous = readDays()
  const retrying = previous.some(row => row.last_error !== '')
  // During a retry, resume from the saved dates even if the navigation page is temporarily unavailable.
  if (!retrying) {
    const index = await getText(indexUrl)
    if (!index) return []
    const days = parseCvfDays(index, indexUrl)
    if (!days.length) {
      const listed = parseCvfPage(index, source.id, year)
      if (listed.length) return listed
      const all = await getText(`${indexUrl}?day=all`)
      return all ? parseCvfPage(all, source.id, year) : []
    }
    for (const day of days) {
      db.prepare('INSERT OR IGNORE INTO cvf_directory_day(conference_id,publication_year,day) VALUES (?,?,?)')
        .run(source.id, year, day)
    }
  }

  const records: ConferencePaper[] = []
  for (const row of readDays()) {
    if (retrying && row.last_error === '') continue
    try {
      const html = await getText(`${indexUrl}?day=${row.day}`, 1)
      const papers = html ? parseCvfPage(html, source.id, year) : []
      if (!papers.length) throw new Error('no recognizable paper entries')
      for (const paper of papers) persist(paper)
      records.push(...papers)
      db.prepare("UPDATE cvf_directory_day SET last_error='' WHERE conference_id=? AND publication_year=? AND day=?")
        .run(source.id, year, row.day)
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 200)
      db.prepare('UPDATE cvf_directory_day SET last_error=? WHERE conference_id=? AND publication_year=? AND day=?')
        .run(message, source.id, year, row.day)
      errors.push(`CVF ${row.day}: ${message}`)
    }
  }
  return records
}

function parseCvfDays(html: string, indexUrl: string): string[] {
  const index = new URL(indexUrl)
  const days = new Set<string>()
  for (const match of html.matchAll(/<a\b([^>]*)>/gi)) {
    const url = absoluteUrl(readHtmlAttribute(match[1], 'href'), indexUrl)
    if (!url) continue
    const link = new URL(url)
    if (link.origin !== index.origin || link.pathname !== index.pathname) continue
    const day = link.searchParams.get('day') || ''
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) days.add(day)
  }
  return [...days].sort()
}

function pendingCvfDetails(source: ConferenceSource, year: number): ConferencePaper[] {
  const prefix = `${source.id}:${source.id}:${year}:`
  const rows = getDb().prepare(`
    SELECT source_key,title,abstract,extra_doi,publication_date,pdf_url FROM articles
    WHERE conference_id=? AND year=? AND source_key LIKE ? AND length(trim(coalesce(abstract,''))) < 50
  `).all(source.id, year, `${prefix}%`) as unknown as Array<{
    source_key: string; title: string; abstract: string | null; extra_doi: string | null
    publication_date: string | null; pdf_url: string | null
  }>
  return rows.flatMap(row => {
    const url = row.source_key.slice(prefix.length)
    if (!url.startsWith('https://openaccess.thecvf.com/')) return []
    return [{
      sourceId: row.source_key.slice(source.id.length + 1), title: row.title, abstract: row.abstract || '',
      doi: row.extra_doi || '', authors: [], publicationDate: row.publication_date || String(year),
      url, pdfUrl: row.pdf_url || '',
    }]
  })
}

export function parseCvfPage(html: string, sourceId: string, year: number): ConferencePaper[] {
  const sections = html.split(/<dt\b[^>]*class=["'][^"']*ptitle[^"']*["'][^>]*>/i).slice(1)
  return sections.map((section, index) => {
    const titleMatch = section.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
    if (!titleMatch) return null
    const title = cleanText(titleMatch[2])
    if (!title) return null
    const body = section.split(/<dt\b/i)[0]
    const url = absoluteUrl(titleMatch[1], 'https://openaccess.thecvf.com/')
    const pdfPath = body.match(/href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/i)?.[1] || ''
    const abstractMatch = body.match(/<(?:div|dd)\b[^>]*(?:id|class)=["'][^"']*abstract[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|dd)>/i)
      || body.match(/<dd\b[^>]*>[\s\S]*?abstract[\s\S]*?<\/dd>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/i)
    const authorBlock = body.match(/<dd\b[^>]*>([\s\S]*?)<\/dd>/i)?.[1] || ''
    const authors = [...authorBlock.matchAll(/<input\b[^>]*name=["']query_author["'][^>]*value=["']([^"']+)["'][^>]*>/gi)]
      .map(match => cleanText(match[1]))
    if (!authors.length) {
      authors.push(...[...authorBlock.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map(match => cleanText(match[1])).filter(Boolean))
    }
    if (!authors.length) authors.push(...splitAuthors(cleanText(authorBlock)))
    return {
      sourceId: `${sourceId}:${year}:${url || index}`,
      doi: '',
      title,
      abstract: cleanText(abstractMatch?.[1] || ''),
      authors,
      publicationDate: `${year}`,
      url,
      pdfUrl: pdfPath ? absoluteUrl(pdfPath, 'https://openaccess.thecvf.com/') : '',
    }
  }).filter((paper): paper is ConferencePaper => !!paper)
}

interface PendingPaperDetail {
  base: ConferencePaper
  html: string
}

async function hydrateConferenceDetails(
  papers: ConferencePaper[],
  parse: (paper: PendingPaperDetail) => ConferencePaper,
  onPaper?: (paper: ConferencePaper) => void,
): Promise<{ records: ConferencePaper[]; failed: number }> {
  const records: ConferencePaper[] = []
  let failed = 0
  const concurrency = 8
  for (let offset = 0; offset < papers.length; offset += concurrency) {
    const batch = papers.slice(offset, offset + concurrency)
    const results = await Promise.all(batch.map(async base => {
      try {
        const html = await getText(base.url)
        if (!html) throw new Error('paper page not found')
        const record = parse({ base, html })
        if (record.abstract.trim().length < 50) throw new Error('paper page has no usable abstract')
        return record
      } catch (error) {
        console.warn(`[ConferenceFetcher] paper detail unavailable: ${base.url} (${error instanceof Error ? error.message : String(error)})`)
        return null
      }
    }))
    for (const record of results) {
      if (record && onPaper) onPaper(record)
      else if (record) records.push(record)
      else failed++
    }
  }
  return { records, failed }
}

export function parseCvfDetail(html: string, base: ConferencePaper): ConferencePaper {
  const metaTitle = getMetaContent(html, 'citation_title')
  const metaAuthors = getMetaContents(html, 'citation_author')
  const authorsBlock = elementById(html, 'authors')
  const metaPdf = getMetaContent(html, 'citation_pdf_url')
  const metaDoi = getMetaContent(html, 'citation_doi')
  const title = metaTitle || cleanText(elementById(html, 'papertitle')) || base.title
  const authorList = metaAuthors.length ? metaAuthors.map(formatCitationAuthor) : splitAuthors(cleanText(authorsBlock))
  return {
    ...base,
    doi: normalizeDoi(metaDoi || base.doi),
    title,
    abstract: cleanText(elementById(html, 'abstract')) || base.abstract,
    authors: authorList.length ? authorList : base.authors,
    publicationDate: getMetaContent(html, 'citation_publication_date') || base.publicationDate,
    pdfUrl: metaPdf ? absoluteUrl(metaPdf, base.url) : base.pdfUrl,
  }
}

async function fetchEcva(source: ConferenceSource, year: number): Promise<ConferencePaper[]> {
  const html = await getText('https://www.ecva.net/papers.php')
  return html ? parseEcvaIndex(html, source.id, year) : []
}

export function parseEcvaIndex(html: string, sourceId: string, year: number): ConferencePaper[] {
  const editionPattern = /<button\b[^>]*>([\s\S]*?)<\/button>\s*<div\b[^>]*class=["'][^"']*accordion-content[^"']*["'][^>]*>([\s\S]*?)(?=<button\b|<\/main\b|<\/body\b|$)/gi
  const edition = [...html.matchAll(editionPattern)].find(match => {
    const editionYear = match[1].match(/ECCV\s+(20\d{2})\s+Papers/i)?.[1]
    return Number(editionYear) === year
  })
  if (!edition) return []

  const sections = edition[2].split(/<dt\b[^>]*class=["'][^"']*ptitle[^"']*["'][^>]*>/i).slice(1)
  return sections.map((section, index) => {
    const body = section.split(/<dt\b/i)[0]
    const anchors = [...body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    const titleLink = anchors.find(match => /\.php(?:[?#]|$)/i.test(readHtmlAttribute(match[1], 'href'))
      && !/springer\.com|\.pdf/i.test(readHtmlAttribute(match[1], 'href')))
    if (!titleLink) return null
    const title = cleanText(titleLink[2])
    if (!title) return null
    const url = absoluteUrl(readHtmlAttribute(titleLink[1], 'href'), 'https://www.ecva.net/')
    const pdfPath = anchors.map(match => readHtmlAttribute(match[1], 'href')).find(href => /\.pdf(?:[?#]|$)/i.test(href)) || ''
    const doiPath = anchors.find(match => /springer\.com\/chapter\//i.test(readHtmlAttribute(match[1], 'href')))
    const authorText = cleanText(body.match(/<dd\b[^>]*>([\s\S]*?)<\/dd>/i)?.[1] || '')
    return {
      sourceId: `${sourceId}:${year}:${url || index}`,
      doi: doiPath ? doiFromValue(readHtmlAttribute(doiPath[1], 'href')) : '',
      title,
      abstract: '',
      authors: splitAuthors(authorText),
      publicationDate: String(year),
      url,
      pdfUrl: pdfPath ? absoluteUrl(pdfPath, 'https://www.ecva.net/') : '',
    }
  }).filter((paper): paper is ConferencePaper => !!paper)
}

export function parseEcvaDetail(html: string, base: ConferencePaper): ConferencePaper {
  const title = cleanText(elementById(html, 'papertitle')) || base.title
  const authors = splitAuthors(cleanText(elementById(html, 'authors')))
  const abstract = cleanText(elementById(html, 'abstract')) || base.abstract
  const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
  const doiLink = links.find(match => /springer\.com\/chapter\//i.test(readHtmlAttribute(match[1], 'href')))
  const pdfPath = links.map(match => readHtmlAttribute(match[1], 'href')).find(href => /\.pdf(?:[?#]|$)/i.test(href)) || ''
  return {
    ...base,
    title,
    abstract,
    authors: authors.length ? authors : base.authors,
    doi: doiLink ? doiFromValue(readHtmlAttribute(doiLink[1], 'href')) : base.doi,
    pdfUrl: pdfPath ? absoluteUrl(pdfPath, base.url) : base.pdfUrl,
  }
}

async function syncIclrYear(year: number, persist: (paper: ConferencePaper) => void): Promise<{ errors: string[] }> {
  const indexUrl = `https://iclr.cc/virtual/${year}/papers.html`
  const html = await getText(indexUrl)
  if (!html) return { errors: [] }

  const papers = parseIclrIndex(html, year)
  if (!papers.length) throw new Error(`ICLR ${year} official index contains no recognizable paper links`)
  const source = { id: 'iclr' }
  const missing = papers.filter(paper => !hasStoredAbstract(source, paper))
  for (const paper of missing) persist(paper)

  const { failed } = await hydrateConferenceDetails(missing, ({ html, base }) => parseIclrDetail(html, base), persist)
  return { errors: failed ? [`ICLR official site: ${failed} paper detail request(s) failed`] : [] }
}

export function parseIclrIndex(html: string, year: number): ConferencePaper[] {
  const papers = new Map<string, ConferencePaper>()
  const paperPath = new RegExp(`^/virtual/${year}/(?:poster|oral|spotlight)/(\\d+)/?$`)
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = readHtmlAttribute(match[1], 'href')
    const title = cleanText(match[2])
    if (!href || !title) continue
    const url = absoluteUrl(href, 'https://iclr.cc/')
    if (!url) continue
    const { hostname, pathname } = new URL(url)
    const id = paperPath.exec(pathname)?.[1]
    if (hostname !== 'iclr.cc' || !id || papers.has(id)) continue
    papers.set(id, {
      sourceId: `iclr:${year}:${id}`, doi: '', title, abstract: '',
      authors: [], publicationDate: String(year), url: `https://iclr.cc${pathname}`, pdfUrl: '',
    })
  }
  return [...papers.values()]
}

export function parseIclrDetail(html: string, base: ConferencePaper): ConferencePaper {
  const authors = cleanText(elementByClass(html, 'event-organizers')).split(/\s*[⋅·]\s*/).filter(Boolean)
  const abstract = cleanText(elementByClass(html, 'abstract-text-inner') || elementByClass(html, 'abstract-content'))
  const forum = html.match(/https:\/\/openreview\.net\/forum\?id=([\w-]+)/i)?.[1]
  return {
    ...base,
    authors: authors.length ? authors : base.authors,
    abstract: abstract || base.abstract,
    pdfUrl: forum ? `https://openreview.net/pdf?id=${encodeURIComponent(forum)}` : base.pdfUrl,
  }
}

export async function fetchNeuripsIndex(year: number): Promise<ConferencePaper[]> {
  const rootUrl = `https://proceedings.neurips.cc/paper_files/paper/${year}`
  const root = await getText(rootUrl)
  if (!root) return []
  const indexUrl = findNeuripsMainConferenceUrl(root, rootUrl)
  if (!indexUrl) throw new Error(`NeurIPS ${year} main-conference index not found`)
  const index = await getText(indexUrl)
  return index ? parseNeuripsIndex(index, year, indexUrl) : []
}

export function findNeuripsMainConferenceUrl(html: string, rootUrl: string): string {
  const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
  const main = links.find(match => /main\s+conference/i.test(cleanText(match[2]))
    && /vol\d+-main-conference/i.test(readHtmlAttribute(match[1], 'href')))
  return main ? absoluteUrl(readHtmlAttribute(main[1], 'href'), rootUrl) : ''
}

export function parseNeuripsIndex(html: string, year: number, indexUrl: string): ConferencePaper[] {
  const matches = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .filter(match => /-Abstract-Conference\.html(?:[?#]|$)/i.test(readHtmlAttribute(match[1], 'href')))
  return matches.map((match, index) => {
    const url = absoluteUrl(readHtmlAttribute(match[1], 'href'), indexUrl)
    const nextIndex = matches[index + 1]?.index ?? html.length
    const itemHtml = html.slice(match.index || 0, nextIndex)
    const authorText = itemHtml.match(/<span\b[^>]*class=["'][^"']*paper-authors[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || ''
    const title = cleanText(match[2])
    if (!title) return null
    return {
      sourceId: `neurips:${year}:${url || index}`, doi: '', title, abstract: '',
      authors: splitAuthors(cleanText(authorText)), publicationDate: String(year),
      url, pdfUrl: '',
    }
  }).filter((paper): paper is ConferencePaper => !!paper)
}

export function parseNeuripsDetail(html: string, base: ConferencePaper): ConferencePaper {
  const abstract = elementByClass(html, 'paper-abstract') || elementById(html, 'abstract')
    || html.match(/<h[34][^>]*>\s*Abstract\s*<\/h[34]>\s*<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] || ''
  const authorText = elementByClass(html, 'paper-authors')
    || html.match(/<h[34][^>]*>\s*Authors\s*<\/h[34]>\s*<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] || ''
  const metaAuthors = getMetaContents(html, 'citation_author')
  const doiLink = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .find(match => /doi\.org\//i.test(readHtmlAttribute(match[1], 'href')))
  const doi = getMetaContent(html, 'citation_doi') || (doiLink ? doiFromValue(readHtmlAttribute(doiLink[1], 'href')) : '')
  const pdf = getMetaContent(html, 'citation_pdf_url') || [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .map(match => readHtmlAttribute(match[1], 'href')).find(href => /\.pdf(?:[?#]|$)/i.test(href)) || ''
  return {
    ...base,
    doi: normalizeDoi(doi || base.doi),
    abstract: cleanText(abstract) || base.abstract,
    authors: splitAuthors(cleanText(authorText)).length
      ? splitAuthors(cleanText(authorText))
      : metaAuthors.length ? metaAuthors.map(formatCitationAuthor) : base.authors,
    pdfUrl: pdf ? absoluteUrl(pdf, base.url) : base.pdfUrl,
  }
}

async function fetchCrossref(source: ConferenceSource, year: number): Promise<ConferencePaper[]> {
  const papers: ConferencePaper[] = []
  let cursor = '*'
  for (let page = 0; page < 4; page++) {
    const url = new URL('https://api.crossref.org/works')
    url.searchParams.set('filter', `from-pub-date:${year}-01-01,until-pub-date:${year}-12-31,type:proceedings-article`)
    url.searchParams.set('query.bibliographic', `${source.name} conference proceedings ${year}`)
    url.searchParams.set('rows', '500')
    url.searchParams.set('cursor', cursor)
    url.searchParams.set('select', 'DOI,title,abstract,author,published,published-print,published-online,URL,link,container-title,event')
    const body = await getText(url.toString())
    if (!body) break
    const data = JSON.parse(body) as { message?: { items?: CrossrefWork[]; 'next-cursor'?: string } }
    const items = data.message?.items || []
    for (const item of items) {
      const title = firstText(item.title)
      if (!title || isNonResearchProceedingsTitle(title) || !matchesVenue(source, item)) continue
      const dateParts = item['published-online']?.['date-parts']?.[0]
        || item.published?.['date-parts']?.[0]
        || item['published-print']?.['date-parts']?.[0]
      const itemYear = Number(dateParts?.[0] || year)
      if (!isEligiblePublicationYear(itemYear)) continue
      papers.push({
        sourceId: `crossref:${normalizeDoi(item.DOI) || title}`,
        doi: normalizeDoi(item.DOI || ''), title,
        abstract: cleanText(item.abstract || ''),
        authors: (item.author || []).map(author => `${author.given || ''} ${author.family || ''}`.trim()).filter(Boolean),
        publicationDate: dateParts?.length ? dateParts.map(part => String(part).padStart(2, '0')).join('-') : String(itemYear),
        url: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : ''),
        pdfUrl: item.link?.find(link => /pdf/i.test(link['content-type'] || ''))?.URL || '',
      })
    }
    const next = data.message?.['next-cursor']
    if (!next || next === cursor || items.length < 500) break
    cursor = next
  }
  return papers
}

interface CrossrefWork {
  DOI?: string
  title?: string[] | string
  abstract?: string
  author?: Array<{ given?: string; family?: string }>
  'published-online'?: { 'date-parts'?: number[][] }
  'published-print'?: { 'date-parts'?: number[][] }
  published?: { 'date-parts'?: number[][] }
  'container-title'?: string[] | string
  event?: { name?: string; acronym?: string }
  URL?: string
  link?: Array<{ URL?: string; 'content-type'?: string }>
}

async function fetchOpenAlex(source: ConferenceSource, year: number): Promise<ConferencePaper[]> {
  const papers: ConferencePaper[] = []
  let cursor = '*'
  for (let page = 0; page < 5; page++) {
    const url = new URL('https://api.openalex.org/works')
    url.searchParams.set('search', source.name)
    url.searchParams.set('filter', `from_publication_date:${year}-01-01,to_publication_date:${year}-12-31,type:conference-paper`)
    url.searchParams.set('per-page', '200')
    url.searchParams.set('cursor', cursor)
    const body = await getText(url.toString())
    if (!body) break
    const data = JSON.parse(body) as { results?: OpenAlexWork[]; meta?: { next_cursor?: string | null } }
    const items = data.results || []
    for (const item of items) {
      const venue = [item.primary_location?.source?.display_name, ...(item.locations || []).map(location => location.source?.display_name)].filter(Boolean).join(' ')
      if (!matchesAlias(source, venue)) continue
      const title = item.title || ''
      if (!title || isNonResearchProceedingsTitle(title)) continue
      const itemYear = publicationYear(item.publication_date || '')
      if (!isEligiblePublicationYear(itemYear)) continue
      papers.push({
        sourceId: `openalex:${item.id || item.doi || title}`, doi: normalizeDoi(item.doi || ''), title,
        abstract: reconstructAbstract(item.abstract_inverted_index),
        authors: (item.authorships || []).map(row => row.author?.display_name || '').filter(Boolean),
        publicationDate: item.publication_date || String(itemYear),
        url: item.doi || item.primary_location?.landing_page_url || '',
        pdfUrl: item.best_oa_location?.pdf_url || '',
      })
    }
    const next = data.meta?.next_cursor
    if (!next || next === cursor || items.length < 200) break
    cursor = next
  }
  return papers
}

interface OpenAlexWork {
  id?: string
  doi?: string | null
  title?: string | null
  publication_date?: string | null
  abstract_inverted_index?: Record<string, number[]> | null
  authorships?: Array<{ author?: { display_name?: string } }>
  primary_location?: { landing_page_url?: string | null; source?: { display_name?: string | null } | null } | null
  locations?: Array<{ source?: { display_name?: string | null } | null }>
  best_oa_location?: { pdf_url?: string | null } | null
}

function matchesVenue(source: ConferenceSource, item: CrossrefWork): boolean {
  const event = item.event || {}
  const venue = `${firstText(item['container-title'])} ${event.name || ''} ${event.acronym || ''}`
  return matchesAlias(source, venue)
}

export function isNonResearchProceedingsTitle(title: string): boolean {
  return /\bvolume\s+\d+\b/i.test(title)
    || /^proceedings of\b/i.test(title)
    || /^(?:introduction|foreword|preface|editorial)\s*[(—:]/i.test(title)
}

function matchesAlias(source: ConferenceSource, value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  return source.aliases.some(alias => normalized.includes(alias.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()))
}

export function mergePaperSources(records: ConferencePaper[]): ConferencePaper[] {
  const merged: ConferencePaper[] = []
  const bySourceId = new Map<string, ConferencePaper>()
  const byDoi = new Map<string, ConferencePaper>()
  const byTitleYear = new Map<string, ConferencePaper[]>()
  for (const paper of records) {
    if (!paper.title) continue
    const doi = normalizeDoi(paper.doi)
    const normalizedTitle = normalizeArticleTitle(paper.title)
    const year = paper.publicationDate.slice(0, 4)
    const direct = bySourceId.get(paper.sourceId) || (doi ? byDoi.get(doi) : undefined)
    const author = normalizeArticleTitle(paper.authors[0] || '')
    const candidates = byTitleYear.get(`${normalizedTitle}:${year}`) || []
    const matches = direct ? [] : candidates.filter(candidate =>
      (!doi || !candidate.doi || doi === normalizeDoi(candidate.doi))
      && (!author || !candidate.authors[0] || normalizeArticleTitle(candidate.authors[0]) === author))
    const current = direct || (matches.length === 1 ? matches[0] : undefined)
    if (!current) {
      merged.push(paper)
      if (paper.sourceId) bySourceId.set(paper.sourceId, paper)
      if (doi) byDoi.set(doi, paper)
      const titleYearKey = `${normalizedTitle}:${year}`
      const titleMatches = byTitleYear.get(titleYearKey) || []
      titleMatches.push(paper)
      byTitleYear.set(titleYearKey, titleMatches)
      continue
    }
    mergePaperFields(current, paper)
    if (paper.sourceId) bySourceId.set(paper.sourceId, current)
    if (doi) byDoi.set(doi, current)
  }
  return merged
}

function mergePaperFields(current: ConferencePaper, paper: ConferencePaper): void {
  if (paper.abstract.length > current.abstract.length) current.abstract = paper.abstract
  if (!current.doi && paper.doi) current.doi = paper.doi
  if (!current.authors.length && paper.authors.length) current.authors = paper.authors
  if (!current.pdfUrl && paper.pdfUrl) current.pdfUrl = paper.pdfUrl
  if (!current.url && paper.url) current.url = paper.url
}

export function upsertConferencePaper(source: Pick<ConferenceConfig, 'id' | 'name'>, year: number, paper: ConferencePaper): boolean {
  const db = getDb()
  const doi = normalizeDoi(paper.doi)
  const sourceKey = `${source.id}:${paper.sourceId}`.slice(0, 900)
  const internalKey = doi || `paperfeed:${sourceKey}`
  let existing = doi
    ? db.prepare('SELECT id,abstract,extra_doi,source_key FROM articles WHERE doi=? OR lower(extra_doi)=? LIMIT 1').get(doi, doi) as ExistingPaper | undefined
    : undefined
  // The nonempty condition lets SQLite use the existing partial source-key index.
  if (!existing) existing = db.prepare("SELECT id,abstract,extra_doi,source_key FROM articles WHERE source_key=? AND source_key!=''").get(sourceKey) as ExistingPaper | undefined

  if (!existing) {
    const exactMatches = db.prepare('SELECT id,title,authors,abstract,extra_doi,source_key FROM articles WHERE year=? AND conference_id=? AND title=? LIMIT 2')
      .all(year, source.id, paper.title) as unknown as ExistingPaper[]
    const normalizedTitle = normalizeArticleTitle(paper.title)
    const authorHead = normalizeArticleTitle(paper.authors[0] || '')
    const candidates = exactMatches.length ? exactMatches : db.prepare(
      'SELECT id,title,authors,abstract,extra_doi,source_key FROM articles WHERE year=? AND conference_id=?'
    ).all(year, source.id) as unknown as ExistingPaper[]
    const matches = candidates.filter(candidate => normalizeArticleTitle(candidate.title || '') === normalizedTitle
      && (!authorHead || !candidate.authors || candidate.authors === '[]' || normalizeArticleTitle(firstAuthor(candidate.authors)) === authorHead))
    if (matches.length === 1) existing = matches[0]
  }

  const abstract = cleanText(paper.abstract)
  const authors = JSON.stringify(paper.authors)
  if (existing) {
    db.prepare(`UPDATE articles SET
      doi=CASE WHEN doi LIKE 'paperfeed:%' AND ?!='' THEN ? ELSE doi END,
      extra_doi=CASE WHEN (extra_doi IS NULL OR extra_doi='') AND ?!='' THEN ? ELSE extra_doi END,
      abstract=CASE WHEN length(COALESCE(abstract,''))<length(?) THEN ? ELSE abstract END,
      authors=CASE WHEN authors IS NULL OR authors='' OR authors='[]' THEN ? ELSE authors END,
      source_key=CASE WHEN source_key IS NULL OR source_key='' THEN ? ELSE source_key END,
      conference_id=CASE WHEN conference_id IS NULL OR conference_id='' THEN ? ELSE conference_id END,
      source_type='conference',
      url=CASE WHEN url IS NULL OR url='' THEN ? ELSE url END,
      pdf_url=CASE WHEN pdf_url IS NULL OR pdf_url='' THEN ? ELSE pdf_url END,
      display_status=CASE WHEN length(?)>=50 AND display_status IN ('no_abstract','failed') THEN NULL ELSE display_status END
      WHERE id=?`).run(doi, doi, doi, doi, abstract, abstract, authors, sourceKey, source.id, paper.url, paper.pdfUrl, abstract, existing.id)
    return false
  }

  db.prepare(`INSERT INTO articles
    (doi,title,abstract,authors,journal,issn,publication_date,year,url,pdf_url,extra_doi,source_type,source_key,conference_id)
    VALUES (?,?,?,?,?,NULL,?,?,?,?,?,'conference',?,?)`).run(
    internalKey, paper.title, abstract, authors, source.name, paper.publicationDate || String(year), year,
    paper.url, paper.pdfUrl, doi, sourceKey, source.id,
  )
  return true
}

interface ExistingPaper {
  id: number
  title?: string
  authors?: string | null
  abstract?: string | null
  extra_doi?: string | null
  source_key?: string | null
}

function firstAuthor(value: string): string {
  try { return String(JSON.parse(value)[0] || '') } catch { return value.split(',')[0] || '' }
}

function publicationYear(value: string): number {
  const match = String(value).match(/\b(20\d{2})\b/)
  return match ? Number(match[1]) : 0
}

function firstText(value: string[] | string | undefined): string {
  return (Array.isArray(value) ? value[0] : value || '').trim()
}

function reconstructAbstract(index: Record<string, number[]> | null | undefined): string {
  if (!index) return ''
  const words: string[] = []
  for (const [word, positions] of Object.entries(index)) for (const position of positions) words[position] = word
  return words.join(' ').trim()
}

function cleanText(value: string): string {
  return decodeHtml(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim()
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const point = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match
    }
    return named[entity.toLowerCase()] || match
  })
}

function absoluteUrl(value: string, base: string): string {
  try { return new URL(value, base).toString() } catch { return '' }
}

function elementById(html: string, id: string): string {
  const opening = [...html.matchAll(/<([a-z][\w:-]*)\b[^>]*>/gi)].find(match => readHtmlAttribute(match[0], 'id') === id)
  if (!opening) return ''
  const start = (opening.index || 0) + opening[0].length
  const end = html.toLowerCase().indexOf('</' + opening[1].toLowerCase() + '>', start)
  return end < 0 ? '' : html.slice(start, end)
}

function elementByClass(html: string, className: string): string {
  const opening = [...html.matchAll(/<([a-z][\w:-]*)\b[^>]*>/gi)].find(match =>
    readHtmlAttribute(match[0], 'class').split(/\s+/).includes(className))
  if (!opening) return ''
  const start = (opening.index || 0) + opening[0].length
  const end = html.toLowerCase().indexOf('</' + opening[1].toLowerCase() + '>', start)
  return end < 0 ? '' : html.slice(start, end)
}

function readHtmlAttribute(attributes: string, name: string): string {
  for (const match of attributes.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    if (match[1].toLowerCase() === name.toLowerCase()) return decodeHtml(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return ''
}

function getMetaContents(html: string, name: string): string[] {
  return [...html.matchAll(/<meta\b([^>]*)>/gi)]
    .filter(match => readHtmlAttribute(match[1], 'name').toLowerCase() === name.toLowerCase())
    .map(match => readHtmlAttribute(match[1], 'content'))
    .filter(Boolean)
}

function getMetaContent(html: string, name: string): string {
  return getMetaContents(html, name)[0] || ''
}

function formatCitationAuthor(value: string): string {
  const parts = value.split(',').map(part => part.trim()).filter(Boolean)
  return parts.length === 2 ? parts[1] + ' ' + parts[0] : value
}

function splitAuthors(value: string): string[] {
  return value.split(/,\s*/).map(author => author.trim()).filter(Boolean)
}

function doiFromValue(value: string): string {
  const direct = normalizeDoi(value)
  if (direct) return direct
  const match = value.match(/10\.\d{4,9}\/[^\s/?#"'<>]+/i)
  return normalizeDoi(match?.[0])
}
