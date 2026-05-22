/**
 * OpenAI API 适配器（兼容所有 OpenAI 格式的 API，如 DeepSeek、Kimi 等）
 */

interface LLMConfig {
  model: string
  apiKey: string
  baseUrl?: string
}

const ANALYSIS_PROMPT = `你是一位资深学术审稿人，擅长快速提炼论文核心信息。

请分析以下论文的标题和摘要，提取以下信息，用 JSON 返回：

1. tldr: 用一句通俗易懂的中文概括这篇论文做了什么（不超过50字）
2. research_question: 论文要解决的核心研究问题（1-2句中文）
3. method: 研究方法、数据来源和分析手段（2-3句中文）
4. innovation: 核心创新点关键词列表（3-5个中文短语的JSON数组）
5. findings: 关键发现和结论（2-3句中文）
6. topics: 5-10个研究方向关键词（中英文混合的JSON数组，用于后续推荐匹配）
7. limitations: 研究的局限性或不足（1-2句中文，如摘要未提及则写"未提及"）

论文标题：{title}
论文摘要：{abstract}

仅返回合法的 JSON 对象，不要包含 markdown 代码块标记或其他文字。`

export async function analyzeWithOpenAI(
  title: string,
  abstract: string,
  config: LLMConfig
): Promise<string> {
  const baseUrl = config.baseUrl || 'https://api.openai.com/v1'
  const prompt = ANALYSIS_PROMPT
    .replace('{title}', title)
    .replace('{abstract}', abstract || '摘要未提供')

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: 'system',
          content: '你是一个学术论文分析助手。你只返回合法的 JSON 对象，不包含任何其他文本。',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 1024,
      response_format: { type: 'json_object' },
    }),
  })

  if (!response.ok) {
    throw new Error(`OpenAI API returned ${response.status}`)
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>
  }

  return data.choices[0]?.message?.content || '{}'
}
