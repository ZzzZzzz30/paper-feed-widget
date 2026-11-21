import type { ReactNode } from 'react'
import { X } from 'lucide-react'

export default function WindowHeader({ icon, title, children, onClose }: {
  icon: ReactNode; title: string; children?: ReactNode; onClose?: () => void
}) {
  return <header className="paper-header drag-handle">
    <span className="paper-header-name">{icon}<span>{title}</span></span>
    <div className="paper-header-controls no-drag">
      {children}
      {onClose && <button type="button" aria-label="关闭" title="关闭" onClick={onClose}><X size={16} /></button>}
    </div>
  </header>
}
