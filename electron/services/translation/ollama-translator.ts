import http from 'http'
import { TranslateInput, TranslateResult, TranslationFailedError, TranslationUnavailableError } from './types'

export async function translateWithOllama(input: TranslateInput): Promise<TranslateResult> {
  const title_cn = await translateText(input.title)
  const abstract_cn = await translateText(input.abstract.slice(0, 1500))
  return { title_cn, abstract_cn, provider: 'ollama' }
}

function translateText(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const prompt = '将以下文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n\n' + text
    const body = JSON.stringify({ model: 'hy-mt-1.8b', prompt, stream: false, options: { temperature: 0.1, num_predict: 512 } })
    const req = http.request({
      hostname: '127.0.0.1', port: 11434, path: '/api/generate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 90_000,
    }, (res) => {
      let d = ''; res.on('data', c => d += c)
      res.on('end', () => {
        try {
          const result = JSON.parse(d) as { response?: string; error?: string; done_reason?: string }
          if (res.statusCode !== 200 || result.error) {
            throw new TranslationUnavailableError(result.error || 'Ollama HTTP ' + res.statusCode)
          }
          if (result.done_reason === 'length') throw new TranslationFailedError('Ollama translation reached its output limit')
          const translation = result.response?.trim()
          if (!translation) throw new TranslationFailedError('Ollama returned an empty translation')
          resolve(translation)
        } catch (error) { reject(error) }
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')) })
    req.write(body); req.end()
  })
}
