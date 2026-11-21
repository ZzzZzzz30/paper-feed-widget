export interface CrossRefArticleCandidate {
  DOI?: string
  title?: string | string[]
  type?: string
  abstract?: string
  ISSN?: string[]
  published?: { 'date-parts'?: number[][] }
  'published-print'?: { 'date-parts'?: number[][] }
  'published-online'?: { 'date-parts'?: number[][] }
  author?: Array<{ given?: string; family?: string }>
}

export function normalizeArticleTitle(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, '"')
    .replace(/&ndash;/gi, '-')
    .replace(/&mdash;/gi, '-')
    .replace(/&hellip;/gi, '...')
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, code: string) => {
      const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : parseInt(code, 10)
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ''
    })
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Keep mathematical symbols and meaningful punctuation when comparing titles. */
export function normalizeDoi(value: string | undefined | null): string {
  const doi = (value || '').trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '')
  return /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi.toLowerCase() : ''
}

export function findExactJournalArticle<T extends CrossRefArticleCandidate>(
  title: string,
  candidates: T[],
  expected: { issn?: string; year?: number; doi?: string; type?: string | string[] } = {}
): T | undefined {
  const normalized = normalizeArticleTitle(title)
  if (!normalized) return undefined
  const matches = candidates.filter(candidate => {
    const candidateTitle = Array.isArray(candidate.title) ? candidate.title[0] : candidate.title
    const doi = normalizeDoi(candidate.DOI)
    const years = [candidate.published, candidate['published-print'], candidate['published-online']]
      .map(date => date?.['date-parts']?.[0]?.[0]).filter((year): year is number => !!year)
    const allowedTypes = expected.type ? (Array.isArray(expected.type) ? expected.type : [expected.type]) : ['journal-article']
    return !!candidate.type && allowedTypes.includes(candidate.type)
      && !!doi
      && !!candidateTitle
      && normalizeArticleTitle(candidateTitle) === normalized
      && (!expected.issn || !candidate.ISSN?.length || candidate.ISSN.some(issn => issn.toUpperCase() === expected.issn!.toUpperCase()))
      && (!expected.doi || doi === normalizeDoi(expected.doi))
      && (!expected.year || years.length === 0 || years.some(year => Math.abs(year - expected.year!) <= 1))
  })
  // A title shared by distinct DOIs is ambiguous; leave it unresolved.
  return new Set(matches.map(candidate => normalizeDoi(candidate.DOI))).size === 1 ? matches[0] : undefined
}
