import type { ActionBarKey, InteractionAction } from '../types'

interface Props {
  onAction: (action: ActionBarKey) => void
  onRemoveBookmark?: () => void
  onAnalyze?: () => void
  disabled?: boolean
  mode?: 'push' | 'bookmarks'
}

const pushActions: Array<{ key: ActionBarKey; icon: string; label: string; colorClass: string }> = [
  { key: 'dislike', icon: '👎', label: '不推送', colorClass: 'hover:bg-red-500/15 hover:text-red-300' },
  { key: 'skip', icon: '↔️', label: '跳过', colorClass: 'hover:theme-bg-hover hover:theme-text-secondary' },
  { key: 'bookmark', icon: '⭐', label: '收藏', colorClass: 'hover:bg-yellow-500/15 hover:text-yellow-300' },
  { key: 'analyze', icon: '🤖', label: '分析', colorClass: 'hover:bg-purple-500/15 hover:text-purple-300' },
]

const btnClass = "no-drag flex flex-col items-center gap-1 px-3 py-2 rounded-xl theme-text-muted text-xs transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed active:scale-90"

export default function ActionBar({ onAction, onRemoveBookmark, onAnalyze, disabled, mode = 'push' }: Props) {
  if (mode === 'bookmarks') {
    return (
      <div className="theme-inner-panel shrink-0 overflow-hidden">
        <div className="flex justify-around items-center px-2 py-3">
          <button onClick={onRemoveBookmark} disabled={disabled} className={`${btnClass} hover:bg-red-500/15 hover:text-red-300`}>
            <span className="text-xl">🗑️</span><span>取消收藏</span>
          </button>
          <button onClick={() => onAnalyze?.()} disabled={disabled} className={`${btnClass} hover:bg-purple-500/15 hover:text-purple-300`}>
            <span className="text-xl">🤖</span><span>分析</span>
          </button>
          <button onClick={() => onAction('skip')} disabled={disabled} className={`${btnClass} hover:theme-bg-hover hover:theme-text-secondary`}>
            <span className="text-xl">↔️</span><span>上一篇</span>
          </button>
          <button onClick={() => onAction('next' as ActionBarKey)} disabled={disabled} className={`${btnClass} hover:theme-bg-hover hover:theme-text-secondary`}>
            <span className="text-xl">↔️</span><span>下一篇</span>
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="theme-inner-panel shrink-0 overflow-hidden">
      <div className="flex justify-around items-center px-2 py-3">
        {pushActions.map(({ key, icon, label, colorClass }) => (
          <button key={key}
            onClick={(e) => {
              e.stopPropagation()
              if (key === 'analyze') { onAnalyze?.(); return }
              onAction(key)
            }}
            disabled={disabled}
            className={`${btnClass} ${colorClass}`}>
            <span className="text-xl">{icon}</span><span>{label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
