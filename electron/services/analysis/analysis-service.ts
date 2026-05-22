import { getDb } from '../db'
import { askDeepSeek } from './deepseek-client'

const SUMMARY_VERSION = 'brief_v2'

export async function quickSummary(articleId: number): Promise<string> {
  const db = getDb()
  const cached = db.prepare('SELECT summary_cn FROM article_ai_summaries WHERE article_id=? AND prompt_version=?').get(articleId, SUMMARY_VERSION) as {summary_cn:string}|undefined
  if (cached?.summary_cn) return cached.summary_cn

  const a = db.prepare('SELECT title,title_cn,abstract,abstract_cn,extra_doi,journal FROM articles WHERE id=?').get(articleId) as {
    title:string;title_cn:string;abstract:string;abstract_cn:string;extra_doi:string;journal:string
  } | undefined
  if (!a) return '文章数据不完整，无法分析'
  if (!a.abstract && !a.abstract_cn) return '当前文章摘要尚未缓存完成，无法生成概况。请稍后再试。'

  const prompt = `你是一个城市研究、城市规划与地理学方向的论文阅读助手。请基于下面论文的标题和摘要，生成一个简洁、准确的中文概况。

写作要求：
1. 使用清晰的学术语言，但不要堆砌术语。
2. 不要使用夸张、宣传式或过度口语化表达。
3. 不要机械复述摘要。
4. 重点说明"文章主要做了什么"和"研究方法或问题意识上的创新点"。
5. 总长度控制在 180–250 个中文字符。
6. 如果摘要信息不足，请明确说明"仅根据摘要难以判断"。

输出格式固定为：

主要内容：
用 2–3 句话说明这篇文章研究了什么对象、围绕什么问题、得出了什么主要结论。

方法与创新：
用 1–2 句话说明它的方法、数据或研究问题上的特点。不要强行拔高创新性。

论文信息：
期刊：${a.journal || '未知'}
英文标题：${a.title}
中文标题：${a.title_cn || '无'}
DOI：${a.extra_doi || '无'}
英文摘要：${a.abstract || '无'}
中文摘要：${a.abstract_cn || '无'}`

  try {
    const result = await askDeepSeek(
      [{ role: 'user', content: prompt }],
      { feature: 'quick_summary', articleId }
    )
    const summary = result.content
    db.prepare("INSERT OR REPLACE INTO article_ai_summaries(article_id,summary_cn,model,prompt_version,created_at,updated_at) VALUES(?,?,?,?,datetime('now'),datetime('now'))")
      .run(articleId, summary, 'deepseek-v4-flash', SUMMARY_VERSION)
    return summary
  } catch (e) {
    console.error('[Analysis] quickSummary failed:', e)
    throw e
  }
}

export function getOrCreateSession(articleId: number): { sessionId: number; messages: Array<{ role: string; content: string }> } {
  const db = getDb()
  let session = db.prepare('SELECT id FROM analysis_sessions WHERE article_id=? ORDER BY id DESC LIMIT 1').get(articleId) as { id: number } | undefined
  if (!session) {
    const a = db.prepare('SELECT title FROM articles WHERE id=?').get(articleId) as { title: string } | undefined
    const r = db.prepare("INSERT INTO analysis_sessions(article_id,title,created_at) VALUES(?,?,datetime('now'))").run(articleId, a?.title || '')
    session = { id: r.lastInsertRowid as number }
  }
  const messages = db.prepare('SELECT role,content FROM analysis_messages WHERE session_id=? ORDER BY id ASC').all(session.id) as Array<{ role: string; content: string }>
  return { sessionId: session.id, messages }
}

export async function chat(articleId: number, sessionId: number | null, message: string): Promise<{ sessionId: number; reply: string }> {
  const db = getDb()
  // 创建或获取 session
  if (!sessionId) {
    const a = db.prepare('SELECT title FROM articles WHERE id=?').get(articleId) as {title:string}|undefined
    const r = db.prepare("INSERT INTO analysis_sessions(article_id,title,created_at) VALUES(?,?,datetime('now'))").run(articleId, a?.title || '')
    sessionId = r.lastInsertRowid as number
  }

  // 获取文章上下文
  const a = db.prepare('SELECT title,title_cn,abstract,abstract_cn,doi,journal,year FROM articles WHERE id=?').get(articleId) as {
    title:string;title_cn:string;abstract:string;abstract_cn:string;doi:string;journal:string;year:number
  } | undefined

  // 获取历史消息
  const history = db.prepare('SELECT role,content FROM analysis_messages WHERE session_id=? ORDER BY id ASC LIMIT 20').all(sessionId) as Array<{role:string;content:string}>

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: `你是一个帮助研究者快速读懂论文的AI阅读助手。当前文章：${a?.title||''}，期刊：${a?.journal||''}（${a?.year||''}）。中文摘要：${a?.abstract_cn||'无'}。请围绕这篇文章回答用户的问题。` },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ]

  // 保存用户消息
  db.prepare("INSERT INTO analysis_messages(session_id,role,content,created_at) VALUES(?,?,?,datetime('now'))").run(sessionId, 'user', message)

  const result = await askDeepSeek(
    messages,
    { feature: 'chat', articleId }
  )
  const reply = result.content

  // 保存 AI 回复
  db.prepare("INSERT INTO analysis_messages(session_id,role,content,created_at) VALUES(?,?,?,datetime('now'))").run(sessionId, 'assistant', reply)

  return { sessionId, reply }
}
