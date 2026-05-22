import http from 'http'
import { TranslateInput, TranslateResult } from './types'

export function translateWithOllama(input: TranslateInput): Promise<TranslateResult> {
  return new Promise((resolve, reject) => {
    const abs = input.abstract.length > 1500 ? input.abstract.slice(0, 1500) : input.abstract
    const prompt = `将以下英文学术论文标题和摘要翻译为中文。\n\n标题：${input.title}\n\n摘要：${abs}\n\n请输出：\n中文标题：...\n中文摘要：...`
    const body = JSON.stringify({ model: 'gemma3:4b', prompt, stream: false, options: { temperature: 0.1, num_predict: 512 } })
    const req = http.request({
      hostname: '127.0.0.1', port: 11434, path: '/api/generate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 90_000,
    }, (res) => {
      let d = ''; res.on('data', c => d += c)
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`Ollama HTTP ${res.statusCode}`)); return }
        try {
          const raw = JSON.parse(d).response || ''
          const tm = raw.match(/中文标题[：:]\s*(.+)/i)
          const am = raw.match(/中文摘要[：:]\s*([\s\S]+)/i)
          resolve({ title_cn: (tm?.[1] || raw.slice(0, 50)).trim(), abstract_cn: (am?.[1] || '').trim(), provider: 'ollama' })
        } catch { reject(new Error('Ollama parse')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')) })
    req.write(body); req.end()
  })
}
