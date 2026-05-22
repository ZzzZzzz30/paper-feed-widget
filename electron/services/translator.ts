import { getDb } from './db'
import http from 'http'
import { BrowserWindow } from 'electron'

let running = false
const queue: number[] = []
const pendingOrRunning = new Set<number>()

function notifyFrontend(articleId: number, titleCn: string, abstractCn: string): void {
  const wins = BrowserWindow.getAllWindows()
  if (wins.length > 0) {
    wins[0].webContents.send('article:translated', { articleId, titleCn, abstractCn })
  }
}

function callOllama(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'gemma3:4b', prompt, stream: false,
      options: { temperature: 0.1, num_predict: 512 },
    })
    const req = http.request({
      hostname: '127.0.0.1', port: 11434, path: '/api/generate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 90_000,
    }, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return }
        try {
          const outer = JSON.parse(data)
          const text = outer.response || ''
          // 提取中文标题和摘要（不用 JSON mode，直接解析文本）
          const titleMatch = text.match(/中文标题[：:]\s*(.+)/i)
          const absMatch = text.match(/中文摘要[：:]\s*([\s\S]+)/i)
          resolve(JSON.stringify({
            title_cn: titleMatch?.[1]?.trim() || text.slice(0, 50),
            abstract_cn: absMatch?.[1]?.trim() || '',
          }))
        } catch (e) {
          reject(new Error('parse: ' + data.slice(0, 200)))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout 90s')) })
    req.write(body)
    req.end()
  })
}

export function enqueueTranslation(articleIds: number[]): void {
  for (const id of articleIds) {
    if (!pendingOrRunning.has(id)) { pendingOrRunning.add(id); queue.push(id) }
  }
  if (!running) processQueue()
}

async function processQueue(): Promise<void> {
  running = true
  const db = getDb()

  while (queue.length > 0) {
    const id = queue.shift()!
    try {
      const cached = db.prepare("SELECT id FROM articles WHERE id=? AND title_cn IS NOT NULL AND title_cn!=''").get(id) as unknown | undefined
      if (cached) { pendingOrRunning.delete(id); continue }
      const a = db.prepare('SELECT id,title,abstract FROM articles WHERE id=?').get(id) as {id:number;title:string;abstract:string}|undefined
      if (!a?.abstract || a.abstract.length < 50) { pendingOrRunning.delete(id); continue }

      // 截断摘要到 1500 字符
      const abs = a.abstract.length > 1500 ? a.abstract.slice(0, 1500) : a.abstract
      const prompt = `将以下英文学术论文标题和摘要翻译为中文。\n\n标题：${a.title}\n\n摘要：${abs}\n\n请按格式输出：\n中文标题：...\n中文摘要：...`

      console.log(`[Translator] #${id} ${a.title.slice(0,40)} abs_len=${abs.length}`)
      const raw = await callOllama(prompt)
      const p = JSON.parse(raw) as {title_cn:string;abstract_cn:string}
      const r = db.prepare('UPDATE articles SET title_cn=?,abstract_cn=? WHERE id=?').run(p.title_cn,p.abstract_cn,id)
      console.log(`[Translator] #${id} 完成 changes=${r.changes}: ${p.title_cn?.slice(0,30)}`)
      if (r.changes > 0) notifyFrontend(id, p.title_cn, p.abstract_cn)
    } catch (err) {
      console.error(`[Translator] #${id} 失败: ${err}`)
      // 失败后继续下一篇，不阻塞队列
    } finally {
      pendingOrRunning.delete(id)
    }
  }
  running = false
}
