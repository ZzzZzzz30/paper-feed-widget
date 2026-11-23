export const DEFAULT_PUSH_KEYWORDS: string[] = []

export function normalizePushKeywords(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error('推送关键词必须为文字列表')
  }
  const unique = new Map<string, string>()
  for (const item of value) {
    const keyword = item.normalize('NFKC').trim().replace(/\s+/g, ' ')
    if (keyword && !unique.has(keyword.toLowerCase())) unique.set(keyword.toLowerCase(), keyword)
  }
  return [...unique.values()]
}

export function readPushKeywords(value?: string): string[] {
  if (value === undefined) return [...DEFAULT_PUSH_KEYWORDS]
  try { return normalizePushKeywords(JSON.parse(value)) }
  catch { return [...DEFAULT_PUSH_KEYWORDS] }
}

export function createKeywordScorer(keywords: string[]): (title: string, abstract: string) => number {
  const patterns = keywords.map(keyword => {
    const key = keyword.toLowerCase()
    if (key === 'agent') return { agent: true, pattern: /\b(?:multi|single|sub|co|micro|meta|super)?agents?(?:based|driven|powered|enabled|oriented|assisted|guided|centric)?\b/i }
    if (key === 'llm agent') return { agent: false, pattern: /\bllm[\s\p{Pd}]+agents?\b/iu }
    if (key === 'ai agent') return { agent: false, pattern: /\bai[\s\p{Pd}]+agents?\b/iu }
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s\\p{Pd}]+')
    const start = /^[a-z0-9]/i.test(keyword) ? '(?<![\\p{L}\\p{N}_])' : ''
    const end = /[a-z0-9]$/i.test(keyword) ? '(?![\\p{L}\\p{N}_])' : ''
    return { agent: false, pattern: new RegExp(start + escaped + end, 'iu') }
  })
  return (title, abstract) => {
    const text = (title + '\n.\n' + abstract).normalize('NFKC').replace(/<[^>]*>/g, ' ')
    const agentText = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    return patterns.filter(({ agent, pattern }) => pattern.test(agent ? agentText : text)).length
  }
}
