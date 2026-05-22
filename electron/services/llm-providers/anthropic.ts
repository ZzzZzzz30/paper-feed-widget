/**
 * Anthropic Claude API 适配器
 */

interface LLMConfig {
  model: string
  apiKey: string
}

const ANALYSIS_PROMPT = `你是一位资深学术审稿人，擅长快速提炼论文核心信息。

请分析以下论文的标题和摘要，提取以下信息。你必须只返回一个合法的 JSON 对象，不要包含任何其他文字。

论文标题：{title}
论文摘要：{abstract}

返回格式：
{
  "tldr": "用一句通俗易懂的中文概括（不超过50字）",
  "research_question": "论文要解决的核心研究问题",
  "method": "研究方法、数据来源和分析手段",
  "innovation": ["创新点1", "创新点2", "创新点3"],
  "findings": "关键发现和结论",
  "topics": ["关键词1", "关键词2", "关键词3", "关键词4", "关键词5"],
  "limitations": "研究局限性或不足，未提及则写'未提及'"
}`

export async function analyzeWithAnthropic(
  title: string,
  abstract: string,
  config: LLMConfig
): Promise<string> {
  const prompt = ANALYSIS_PROMPT
    .replace('{title}', title)
    .replace('{abstract}', abstract || '摘要未提供')

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 1024,
      temperature: 0.1,
      messages: [
        {
          role: 'user',
          content: prompt + '\n\n请只返回 JSON，不要包含任何其他文字。',
        },
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(`Anthropic API returned ${response.status}`)
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>
  }

  const text = data.content.find(c => c.type === 'text')?.text || '{}'

  // Claude 可能在 JSON 外包裹 markdown 代码块，需要去除
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  return jsonMatch ? jsonMatch[0] : text
}
