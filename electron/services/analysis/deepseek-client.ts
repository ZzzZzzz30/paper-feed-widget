import OpenAI from 'openai'
import { getDb } from '../db'

export interface LlmResult {
  content: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

function getApiKey(): string {
  // 优先从用户设置读取，其次环境变量
  try {
    const db = getDb()
    const row = db.prepare("SELECT value FROM settings WHERE key = 'deepseek_api_key'").get() as { value: string } | undefined
    if (row?.value && row.value.trim()) return row.value.trim()
  } catch { /* db 未初始化 */ }
  return (process.env.DEEPSEEK_API_KEY || '').trim()
}

function createClient(): OpenAI {
  const apiKey = getApiKey()
  if (!apiKey) {
    throw new Error('DeepSeek API Key 未设置，请先在设置页填写 API Key')
  }
  return new OpenAI({ apiKey, baseURL: 'https://api.deepseek.com' })
}

export async function askDeepSeek(
  messages: Array<{ role: string; content: string }>,
  opts?: { feature?: string; articleId?: number }
): Promise<LlmResult> {
  const client = createClient()
  console.log('[DeepSeek] key exists =', !!getApiKey())

  const res = await client.chat.completions.create({
    model: 'deepseek-v4-flash',
    messages: messages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    stream: false,
    temperature: 0.3,
  })

  const content = (res as { choices: Array<{ message: { content: string } }> }).choices[0]?.message?.content || ''

  const usage = res.usage
    ? {
        prompt_tokens: res.usage.prompt_tokens || 0,
        completion_tokens: res.usage.completion_tokens || 0,
        total_tokens: res.usage.total_tokens || 0,
      }
    : undefined

  // 记录用量到数据库
  if (usage && usage.total_tokens > 0) {
    try {
      const db = getDb()
      const inputPrice = getPriceSetting(db, 'deepseek_input_price')
      const outputPrice = getPriceSetting(db, 'deepseek_output_price')
      const costUsd =
        (usage.prompt_tokens / 1_000_000) * inputPrice +
        (usage.completion_tokens / 1_000_000) * outputPrice

      db.prepare(`
        INSERT INTO ai_usage (provider, model, feature, article_id, input_tokens, output_tokens, total_tokens, cost_usd)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'deepseek',
        'deepseek-v4-flash',
        opts?.feature || 'chat',
        opts?.articleId || null,
        usage.prompt_tokens,
        usage.completion_tokens,
        usage.total_tokens,
        costUsd
      )
    } catch (err) {
      console.error('[DeepSeek] 用量记录失败:', err)
    }
  }

  return { content, usage }
}

function getPriceSetting(db: ReturnType<typeof getDb>, key: string): number {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined
    return parseFloat(row?.value || '0') || 0
  } catch {
    return 0
  }
}
