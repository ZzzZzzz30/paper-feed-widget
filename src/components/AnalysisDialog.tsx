import { useState, useRef, useEffect } from 'react'
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

interface Props { articleId: number; articleTitle: string; onClose: () => void; showCloseButton?: boolean }
interface Message { role: 'user' | 'assistant'; content: string }

export default function AnalysisDialog({ articleId, articleTitle, onClose, showCloseButton = true }: Props) {
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
    setLoadedArticleId(articleId)
    setLoading(false)
    console.log('[AnalysisDialog] new empty session for articleId=', articleId)
  }, [articleId])

  const addMsg = (role: 'user' | 'assistant', content: string) => setMessages(p => [...p, { role, content }])

  const handleQuickSummary = async () => {
    setLoading(true)
    try { addMsg('assistant', await window.electronAPI.quickSummary(articleId)) }
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
    <div className="h-full flex flex-col text-xs">
      <div className="drag-region shrink-0 h-10 px-4 flex items-center justify-between border-b theme-border-light">
        <div className="flex items-center gap-2">
          <span>🤖</span>
          <span className="font-medium theme-text-secondary">PaperFeed AI</span>
        </div>
        {showCloseButton && (
          <button onClick={onClose} className="no-drag theme-text-muted hover:theme-text-main text-base">×</button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        {loadedArticleId !== articleId ? (
          <div className="h-full flex items-center justify-center">
            <div className="theme-text-muted text-sm animate-pulse">新对话加载中...</div>
          </div>
        ) : messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center gap-3">
            <div className="theme-text-secondary leading-relaxed">我可以帮你快速读懂这篇文章</div>
            <button onClick={handleQuickSummary} disabled={loading}
              className="no-drag px-4 py-2 rounded-xl font-medium transition disabled:opacity-40"
              style={{ background: 'rgb(var(--accent-rgb) / 0.18)', color: 'rgb(var(--accent-rgb) / 0.95)' }}>
              📋 一键概括这篇文章
            </button>
            <div className="text-[10px] theme-text-subtle leading-relaxed">
              也可以问：这篇文章到底研究什么？<br />这个术语是什么意思？这个选题能怎么扩展？
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((m, i) => (
              <div key={i} className="leading-relaxed">
                <div className="text-[10px] mb-1 theme-text-subtle">{m.role === 'assistant' ? 'AI' : '你'}</div>
                {m.role === 'assistant' ? (
                  <MarkdownMessage content={m.content} />
                ) : (
                  <div className="whitespace-pre-wrap selectable-text theme-text-main">{m.content}</div>
                )}
              </div>
            ))}
            {loading && <div className="theme-text-muted animate-pulse">AI 正在阅读这篇文章...</div>}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 p-3 flex gap-2 border-t theme-border-light">
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSend()}
          placeholder="有问题，尽管问" disabled={loading}
          className="no-drag flex-1 rounded-xl px-3 py-2 text-xs theme-text-secondary outline-none disabled:opacity-40 theme-bg-overlay border theme-border" />
        <button onClick={handleSend} disabled={loading || !input.trim()}
          className="no-drag shrink-0 rounded-xl px-3 py-2 text-xs font-medium disabled:opacity-35"
          style={{ background: 'rgb(var(--accent-rgb) / 0.18)', color: 'rgb(var(--accent-rgb) / 0.95)' }}>
          发送
        </button>
      </div>
    </div>
  )
}
