import { useState, useRef, useEffect } from 'react'
import { ArrowUp, FileText, Sparkles } from 'lucide-react'
import WindowHeader from './WindowHeader'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'

function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="markdown-message selectable-text">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

interface Props { articleId: number; articleTitle: string; onClose: () => void; showCloseButton?: boolean; embedded?: boolean }
interface Message { role: 'user' | 'assistant'; content: string }

export default function AnalysisDialog({ articleId, articleTitle, onClose, showCloseButton = true, embedded = false }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sessionId, setSessionId] = useState<number | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const requestIdRef = useRef(0)
  const [loadedArticleId, setLoadedArticleId] = useState<number | null>(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  useEffect(() => {
    const reqId = ++requestIdRef.current
    setMessages([])
    setInput('')
    setSessionId(null)
    setLoadedArticleId(null)
    setLoading(true)
    console.log('[AnalysisDialog] loading session for articleId=', articleId)

    window.electronAPI.getAnalysisSession(articleId).then(s => {
      if (reqId !== requestIdRef.current) return
      setSessionId(s.sessionId)
      setMessages((s.messages || []) as Message[])
      setLoadedArticleId(articleId)
      setLoading(false)
      console.log('[AnalysisDialog] loaded', (s.messages || []).length, 'messages for articleId=', articleId)
    }).catch(() => {
      if (reqId !== requestIdRef.current) return
      setLoadedArticleId(articleId)
      setLoading(false)
    })
  }, [articleId])

  const addMsg = (role: 'user' | 'assistant', content: string) => setMessages(p => [...p, { role, content }])

  const handleQuickSummary = async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.quickSummary({ articleId, sessionId })
      setSessionId(result.sessionId)
      addMsg('assistant', result.reply)
    }
    catch (e) { addMsg('assistant', '概括失败: ' + String(e)) }
    setLoading(false)
  }

  const handleSend = async () => {
    if (!input.trim() || loading) return
    const msg = input.trim(); setInput(''); addMsg('user', msg); setLoading(true)
    try {
      const result = await window.electronAPI.analysisChat({ articleId, sessionId, message: msg })
      setSessionId(result.sessionId)
      addMsg('assistant', result.reply)
    } catch (e) { addMsg('assistant', '回复失败: ' + String(e)) }
    setLoading(false)
  }

  return (
    <div className="paper-analysis paper-ui">
      {!embedded && <WindowHeader icon={<Sparkles size={16} />} title="AI 分析" onClose={showCloseButton ? onClose : undefined} />}
      {!embedded && articleTitle && <div className="paper-article-context"><span>当前文章</span><p title={articleTitle}>{articleTitle}</p></div>}
      <div className="paper-conversation">
        {loadedArticleId !== articleId ? (
          <div className="paper-ai-empty" role="status">正在加载对话…</div>
        ) : messages.length === 0 ? (
          <div className="paper-ai-empty">
            <div className="paper-ai-emblem"><Sparkles size={26} strokeWidth={1.5} /></div>
            <h2>从一个问题开始</h2>
            <p>快速理解这篇文章的研究思路、<br />方法与可以继续探索的问题。</p>
            <button onClick={handleQuickSummary} disabled={loading} className="paper-primary no-drag">
              <FileText size={16} />{loading ? '正在概括…' : '一键概括这篇文章'}
            </button>
            <span className="paper-ai-hint">也可以问问研究方法、术语或选题方向</span>
          </div>
        ) : (
          <div className="paper-messages">
            {messages.map((m, i) => (
              <div key={i} className="paper-message" data-role={m.role}>
                <div className="paper-message-role">{m.role === 'assistant' ? <><Sparkles size={13} /> PaperFeed AI</> : '你'}</div>
                {m.role === 'assistant' ? <MarkdownMessage content={m.content} /> :
                  <div className="whitespace-pre-wrap selectable-text">{m.content}</div>}
              </div>
            ))}
            {loading && <div className="paper-ai-loading" role="status">AI 正在阅读这篇文章…</div>}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="paper-composer">
        <div className="paper-composer-field">
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSend()}
            placeholder="针对这篇文章提问…" aria-label="向 AI 提问" disabled={loading} className="no-drag" />
          <button onClick={handleSend} disabled={loading || !input.trim()} aria-label="发送" title="发送"
            className="no-drag"><ArrowUp size={17} /></button>
        </div>
        <div className="paper-composer-hint">Enter 发送</div>
      </div>
    </div>
  )
}
