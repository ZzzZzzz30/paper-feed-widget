import { getDb } from './db'
import { analyzeWithOllama, checkOllamaStatus } from './llm-providers/ollama'
import { analyzeWithOpenAI } from './llm-providers/openai'
import { analyzeWithAnthropic } from './llm-providers/anthropic'

interface AnalysisResult {
  tldr: string
  research_question: string
  method: string
  innovation: string[]
  findings: string
  topics: string[]
  limitations: string
}

/**
 * 按需分析单篇文章（用户点击「分析」时触发）
 */
export async function analyzeSingleArticle(articleId: number): Promise<AnalysisResult | null> {
  const db = getDb()

  const provider = db.prepare(
    "SELECT value FROM settings WHERE key = 'llm_provider'"
  ).get() as { value: string } | undefined

  const model = db.prepare(
    "SELECT value FROM settings WHERE key = 'llm_model'"
  ).get() as { value: string } | undefined

  const article = db.prepare(
    'SELECT id, title, abstract FROM articles WHERE id = ?'
  ).get(articleId) as { id: number; title: string; abstract: string } | undefined

  if (!article) return null

  try {
    const startTime = Date.now()
    const result = await analyzeArticle(
      article.title,
      article.abstract,
      provider?.value || 'ollama',
      model?.value || 'qwen2.5:7b'
    )

    db.prepare(`
      INSERT OR REPLACE INTO analysis
        (article_id, tldr, research_question, method, innovation, findings, topics, limitations, raw_json, model_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      article.id,
      result.tldr,
      result.research_question,
      result.method,
      JSON.stringify(result.innovation),
      result.findings,
      JSON.stringify(result.topics),
      result.limitations,
      JSON.stringify(result),
      model?.value || 'unknown'
    )

    db.prepare('UPDATE articles SET is_processed = 1 WHERE id = ?').run(article.id)

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`[Analyzer] 分析完成 (${elapsed}s): ${article.title.slice(0, 50)}...`)
    return result
  } catch (err) {
    console.error(`[Analyzer] 分析失败 article_id=${article.id}:`, err)
    return null
  }
}

export async function analyzeUnprocessedArticles(): Promise<number> {
  const db = getDb()

  // 获取设置
  const provider = db.prepare(
    "SELECT value FROM settings WHERE key = 'llm_provider'"
  ).get() as { value: string } | undefined

  const model = db.prepare(
    "SELECT value FROM settings WHERE key = 'llm_model'"
  ).get() as { value: string } | undefined

  // 获取未分析的文章
  const articles = db.prepare(
    'SELECT id, title, abstract FROM articles WHERE is_processed = 0 LIMIT 20'
  ).all() as Array<{ id: number; title: string; abstract: string }>

  const total = articles.length
  if (total === 0) {
    console.log('[Analyzer] 无待分析文章')
    return 0
  }

  console.log(`[Analyzer] 开始分析 ${total} 篇文章 (模型: ${model?.value || 'qwen2.5:7b'})`)

  let processed = 0
  let index = 0

  for (const article of articles) {
    index++
    const titlePreview = article.title.length > 40 ? article.title.slice(0, 40) + '...' : article.title
    console.log(`[Analyzer] 分析中 [${index}/${total}]: ${titlePreview}`)

    try {
      const startTime = Date.now()
      const result = await analyzeArticle(
        article.title,
        article.abstract,
        provider?.value || 'ollama',
        model?.value || 'qwen2.5:7b'
      )

      // 存储分析结果
      db.prepare(`
        INSERT OR REPLACE INTO analysis
          (article_id, tldr, research_question, method, innovation, findings, topics, limitations, raw_json, model_used)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        article.id,
        result.tldr,
        result.research_question,
        result.method,
        JSON.stringify(result.innovation),
        result.findings,
        JSON.stringify(result.topics),
        result.limitations,
        JSON.stringify(result),
        model?.value || 'unknown'
      )

      // 标记为已处理
      db.prepare('UPDATE articles SET is_processed = 1 WHERE id = ?').run(article.id)
      processed++

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(`[Analyzer] 完成 [${index}/${total}] (${elapsed}s)`)
    } catch (err) {
      console.error(`[Analyzer] 分析失败 article_id=${article.id}:`, err)
    }
  }

  console.log(`[Analyzer] 本轮完成 ${processed}/${total} 篇`)
  return processed
}

async function analyzeArticle(
  title: string,
  abstract: string,
  provider: string,
  model: string
): Promise<AnalysisResult> {
  let rawResponse: string

  switch (provider) {
    case 'openai':
      rawResponse = await analyzeWithOpenAI(title, abstract, {
        model,
        apiKey: getApiKey('openai'),
      })
      break

    case 'anthropic':
      rawResponse = await analyzeWithAnthropic(title, abstract, {
        model,
        apiKey: getApiKey('anthropic'),
      })
      break

    case 'ollama':
    default:
      rawResponse = await analyzeWithOllama(title, abstract, { model })
      break
  }

  return parseAnalysisResponse(rawResponse)
}

function parseAnalysisResponse(raw: string): AnalysisResult {
  try {
    const parsed = JSON.parse(raw)
    return {
      tldr: parsed.tldr || '',
      research_question: parsed.research_question || '',
      method: parsed.method || '',
      innovation: Array.isArray(parsed.innovation) ? parsed.innovation : [],
      findings: parsed.findings || '',
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      limitations: parsed.limitations || '',
    }
  } catch {
    // JSON 解析失败，返回空结果
    console.error('[Analyzer] JSON 解析失败，原始返回:', raw.slice(0, 200))
    return {
      tldr: '',
      research_question: '',
      method: '',
      innovation: [],
      findings: '',
      topics: [],
      limitations: '',
    }
  }
}

function getApiKey(provider: string): string {
  try {
    const db = getDb()
    const result = db.prepare(
      "SELECT value FROM settings WHERE key = ?"
    ).get(`api_key_${provider}`) as { value: string } | undefined
    if (result?.value) return result.value
  } catch {
    // db 未初始化
  }
  // 降级到环境变量
  const envMap: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
  }
  return process.env[envMap[provider]] || ''
}
