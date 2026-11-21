import { ArrowLeft, ArrowRight, Bookmark, BookmarkMinus, NotebookPen, Sparkles, ThumbsDown } from 'lucide-react'
import type { ActionBarKey } from '../types'

interface Props {
  onAction: (action: ActionBarKey) => void
  onRemoveBookmark?: () => void
  onAnalyze?: () => void
  onNote: () => void
  disabled?: boolean
  mode?: 'push' | 'bookmarks'
}

export default function ActionBar({ onAction, onRemoveBookmark, onAnalyze, onNote, disabled, mode = 'push' }: Props) {
  const common = [
    { label: '分析', icon: Sparkles, tone: 'analysis', run: onAnalyze },
    { label: '笔记', icon: NotebookPen, tone: 'note', run: onNote },
  ]
  const actions = mode === 'bookmarks' ? [
    { label: '取消收藏', icon: BookmarkMinus, tone: 'dislike', run: onRemoveBookmark },
    ...common,
    { label: '上一篇', icon: ArrowLeft, tone: '', run: () => onAction('previous') },
    { label: '下一篇', icon: ArrowRight, tone: '', run: () => onAction('next') },
  ] : [
    { label: '不推送', icon: ThumbsDown, tone: 'dislike', run: () => onAction('dislike') },
    { label: '收藏', icon: Bookmark, tone: 'saved', run: () => onAction('bookmark') },
    ...common,
  ]
  return (
    <div className="paper-actions no-drag">
      {actions.map(({ label, icon: Icon, tone, run }) => (
        <button key={label} type="button" title={label} disabled={disabled} data-tone={tone}
          onClick={event => { event.stopPropagation(); run?.() }}>
          <Icon size={16} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  )
}
