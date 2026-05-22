const OLLAMA = 'http://127.0.0.1:11434/api/generate'

export async function translateText(title: string, abstract?: string): Promise<{ title_cn: string; abstract_cn: string } | null> {
  const hasAbs = abstract && abstract.length > 50
  const prompt = hasAbs
    ? `将以下英文学术论文标题和摘要翻译为中文。\n\n标题：${title}\n\n摘要：${abstract}\n\n仅返回JSON：{"title_cn":"中文标题","abstract_cn":"中文摘要"}`
    : `将以下英文学术论文标题翻译为中文。\n\n标题：${title}\n\n仅返回JSON：{"title_cn":"中文标题","abstract_cn":""}`

  try {
    const res = await fetch(OLLAMA, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemma3:4b', prompt, stream: false, format: 'json', options: { temperature: 0.1, num_predict: 1024 } }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { response: string }
    const parsed = JSON.parse(data.response) as { title_cn: string; abstract_cn: string }
    // 异步存后端
    return parsed
  } catch (e) {
    console.error('[Translator] fail:', e)
    return null
  }
}
