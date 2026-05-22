/**
 * ScienceDirect API 客户端
 * 文档: https://dev.elsevier.com/documentation/ScienceDirectSearchAPI.wadl
 *
 * 需要在设置中配置 ELSEVIER_API_KEY
 */

interface ScienceDirectArticleData {
  abstract?: string
  authors?: string
  pdfUrl?: string
  graphicalAbstractUrl?: string
}

/**
 * 通过 PII 获取文章元数据（摘要、DOI、关键词）
 */
/**
 * 通过 PII 获取文章附件（图表、表格等）
 */
export async function fetchAttachmentsByPII(pii: string): Promise<Array<{
  type: string
  url: string
  label: string
}> | null> {
  const apiKey = getApiKey()
  if (!apiKey) return null
  if (!pii.startsWith('S0')) return null

  try {
    const url = `https://api.elsevier.com/content/article/pii/${encodeURIComponent(pii)}`
    const response = await fetch(url, {
      headers: { 'X-ELS-APIKey': apiKey, 'Accept': 'application/json' },
    })
    if (!response.ok) return null
    const data = await response.json() as {
      'full-text-retrieval-response'?: {
        objects?: {
          object?: Array<{
            '@type'?: string
            '$'?: string
            '@ref'?: string
            '@multimediatype'?: string
          }>
        }
      }
    }
    const objects = data?.['full-text-retrieval-response']?.objects?.object || []
    if (objects.length === 0) return null

    return objects.map(o => ({
      type: o['@type'] || 'unknown',
      url: typeof o['$'] === 'string' ? o['$'] : '',
      label: `${o['@ref'] || ''} ${o['@multimediatype'] || ''}`.trim() || o['@type'] || 'attachment',
    }))
  } catch {
    return null
  }
}

export async function fetchArticleByPII(pii: string): Promise<{
  abstract: string
  doi: string
  keywords: string[]
} | null> {
  const apiKey = getApiKey()
  if (!apiKey) return null

  try {
    const url = `https://api.elsevier.com/content/article/pii/${encodeURIComponent(pii)}`
    const response = await fetch(url, {
      headers: {
        'X-ELS-APIKey': apiKey,
        'Accept': 'application/json',
      },
    })

    if (!response.ok) return null

    const data = await response.json() as {
      'full-text-retrieval-response'?: {
        coredata?: {
          'dc:description'?: string
          'prism:doi'?: string
          'dcterms:subject'?: Array<{ $: string }>
        }
      }
    }

    const core = data?.['full-text-retrieval-response']?.coredata
    if (!core) return null

    return {
      abstract: core['dc:description'] || '',
      doi: core['prism:doi'] || '',
      keywords: (core['dcterms:subject'] || []).map(s => s.$),
    }
  } catch (err) {
    console.error('[SD] PII 查询失败:', err)
    return null
  }
}

export async function fetchScienceDirectArticle(
  doi: string
): Promise<ScienceDirectArticleData | null> {
  const apiKey = getApiKey()
  if (!apiKey) return null

  try {
    // ScienceDirect Article Retrieval API
    const url = `https://api.elsevier.com/content/article/doi/${encodeURIComponent(doi)}`

    const response = await fetch(url, {
      headers: {
        'X-ELS-APIKey': apiKey,
        'Accept': 'application/json',
      },
    })

    if (!response.ok) return null

    const data = await response.json() as {
      'full-text-retrieval-response'?: {
        coredata?: {
          'dc:description'?: string
          'dc:creator'?: string | Array<{ $: string }>
          'prism:doi'?: string
        }
        'originalText'?: string  // PDF URL
      }
    }

    const core = data?.['full-text-retrieval-response']
    if (!core) return null

    // Graphical Abstract 通常在 article 的 attachment 中
    const graphicalAbstractUrl = await extractGraphicalAbstract(doi, apiKey)

    return {
      abstract: core.coredata?.['dc:description'] || '',
      authors: extractAuthors(core.coredata?.['dc:creator']),
      pdfUrl: core.originalText || '',
      graphicalAbstractUrl: graphicalAbstractUrl || '',
    }
  } catch (err) {
    console.error('[ScienceDirect] 获取文章失败:', err)
    return null
  }
}

function extractAuthors(
  creator: string | Array<{ $: string }> | undefined
): string {
  if (!creator) return '[]'
  if (typeof creator === 'string') return JSON.stringify([creator])
  return JSON.stringify(creator.map(c => c.$))
}

function getApiKey(): string | null {
  // 优先从数据库读取，其次环境变量
  try {
    const { getDb } = require('./db')
    const db = getDb()
    const row = db.prepare("SELECT value FROM settings WHERE key = 'elsevier_api_key'").get() as { value: string } | undefined
    if (row?.value && row.value.trim()) return row.value.trim()
    console.error('[SD] DB中有key但为空')
  } catch (err) {
    console.error('[SD] 从DB读取API Key失败:', err)
  }
  // 降级到环境变量
  const envKey = process.env.ELSEVIER_API_KEY || null
  if (envKey) {
    console.log('[SD] 使用环境变量 API Key')
  } else {
    console.error('[SD] 无 API Key（DB和环境变量均未找到）')
  }
  return envKey
}

/**
 * 获取 Graphical Abstract URL
 * Elsevier 的 Graphical Abstract 通常通过专门的 API 端点获取
 */
async function extractGraphicalAbstract(
  doi: string,
  apiKey: string
): Promise<string | null> {
  try {
    // 尝试获取文章的 attachments
    const url = `https://api.elsevier.com/content/article/doi/${encodeURIComponent(doi)}`

    const response = await fetch(url, {
      headers: {
        'X-ELS-APIKey': apiKey,
        'Accept': 'application/json',
        'view': 'FULL',
      },
    })

    if (!response.ok) return null
    const data = await response.json() as {
      'full-text-retrieval-response'?: {
        'attachment'?: Array<{
          'attachment-type'?: string
          '$'?: { href?: string }
        }>
      }
    }

    const attachments = data?.['full-text-retrieval-response']?.['attachment'] || []

    // 查找 graphical-abstract 类型的附件
    const gaAttachment = attachments.find(
      a => a['attachment-type'] === 'graphical-abstract'
    )

    return gaAttachment?.$?.href || null
  } catch {
    return null
  }
}
