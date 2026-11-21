
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { ArrowUpRight, BookOpen, ChevronDown } from 'lucide-react'
import { useStore } from '../store'
import type { AppView } from '../types'

type Mode = 'expanded' | 'compact' | 'preview'
type Phase = Mode | 'closing' | 'opening' | 'peeking'
type Rect = { x: number; y: number; width: number; height: number }
// Sample a critically damped response: gentle acceleration, no overshoot, soft landing.
// Geometry, corners and content reveal use the same progress instead of separate clocks.
function hoverFrames(from: Rect, to: Rect, opening: boolean, duration: number, dock: string) {
  const frequency = opening ? 18 : 24
  const response = (t: number) => 1 - (1 + frequency * t) * Math.exp(-frequency * t)
  const end = response(duration / 1000)
  const surface: Keyframe[] = [], reveal: Keyframe[] = [], corners: Keyframe[] = []
  for (let i = 0; i <= 60; i++) {
    const offset = i / 60, progress = response(offset * duration / 1000) / end
    const expansion = opening ? progress : 1 - progress
    const mix = (a: number, b: number) => a + (b - a) * progress
    const radius = 12 + 16 * expansion
    const fraction = Math.max(0, Math.min(1, (expansion - .12) / .76))
    surface.push({ offset, left: mix(from.x, to.x) + 'px', top: mix(from.y, to.y) + 'px',
      width: mix(from.width, to.width) + 'px', height: mix(from.height, to.height) + 'px',
      borderRadius: dock === 'top' ? '0px' : dock === 'left' ? `0px 12px ${radius}px 0px` :
        dock === 'right' ? `12px 0px 0px ${radius}px` : `15px 15px ${15 + 13 * expansion}px ${15 + 13 * expansion}px` })
    reveal.push({ offset, opacity: fraction * fraction * (3 - 2 * fraction) })
    corners.push({ offset, borderRadius: `0px 0px ${radius}px ${radius}px` })
  }
  return { surface, reveal, corners }
}
const frame = (r: Rect, mode: Mode, dock: 'top' | 'left' | 'right' | 'free') => ({
  left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px',
  borderRadius: mode === 'expanded' ? '12px' : dock === 'top' ? '0px' :
    dock === 'left' ? `0px 12px ${mode === 'preview' ? 28 : 12}px 0px` :
    dock === 'right' ? `12px 0px 0px ${mode === 'preview' ? 28 : 12}px` :
    mode === 'preview' ? '15px 15px 28px 28px' : '15px',
})

export default function DesktopPanel({ view, children }: { view: AppView; children: ReactNode }) {
  const [dock, setDock] = useState<'top' | 'left' | 'right' | 'free'>('top')
  const [phase, setPhase] = useState<Phase>('expanded')
  const [contentSize, setContentSize] = useState<{ width: number; height: number }>()
  const [rect, setRect] = useState<Rect>()
  const [previewSize, setPreviewSize] = useState<{ width: number; height: number }>()
  const shell = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const island = useRef<HTMLDivElement>(null)
  const previewContent = useRef<HTMLButtonElement>(null)
  const busy = useRef(false)
  const mode = useRef<Mode>('expanded')
  const desired = useRef<Mode>('expanded')
  const animations = useRef<Animation[]>([])
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>()
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>()
  const pointer = useRef<{ x: number; y: number; moved: boolean }>()
  const resizing = useRef(false)
  const releasing = useRef(false)
  const item = useStore(s => s.queue[s.currentIndex])
  const latestView = useRef(view)
  const previousView = useRef(view)
  latestView.current = view

  function cancelTimers() { clearTimeout(hoverTimer.current); clearTimeout(leaveTimer.current) }
  function settle(target: Mode, frame?: Rect) {
    animations.current.forEach(a => a.cancel())
    animations.current = []
    if (frame) setRect(frame)
    setPreviewSize(undefined)
    if (target === 'expanded') setContentSize(undefined)
    mode.current = target
    setPhase(target)
    busy.current = false
  }
  async function collapsePreviewWhenOutside() {
    if (mode.current !== 'preview' || busy.current || pointer.current) return
    // Native screen coordinates avoid mouseleave events caused by the window's own resize.
    const inside = await window.electronAPI.isIslandHovered().catch(() => true)
    if (!inside && mode.current === 'preview' && !busy.current) void morph('compact')
  }
  function scheduleLeave() {
    clearTimeout(leaveTimer.current)
    if (mode.current === 'preview') leaveTimer.current = setTimeout(() => void collapsePreviewWhenOutside(), 500)
  }
  useEffect(() => window.electronAPI.onIslandDock(setDock), [])
  useEffect(() => window.electronAPI.onWidgetCompactSettled(frame => flushSync(() => settle(desired.current, frame))), [])
  useEffect(() => window.electronAPI.onWindowSurface(({ frame, compact }) => {
    flushSync(() => {
      if (compact) { desired.current = 'compact'; settle('compact', frame) }
      else setRect(frame)
    })
  }), [])
  useEffect(() => { if (content.current) content.current.inert = phase !== 'expanded' }, [phase])
  useEffect(() => () => {
    cancelTimers()
    if (pointer.current) void window.electronAPI.dragIsland('cancel')
    if (resizing.current) void window.electronAPI.resizeSurface('cancel')
  }, [])

  async function morph(target: Mode) {
    if (busy.current || pointer.current || resizing.current || releasing.current || target === mode.current || !shell.current || !content.current || !island.current) return
    cancelTimers()
    busy.current = true
    const origin = mode.current
    const originView = latestView.current
    desired.current = target
    const compact = target === 'compact'
    const preview = target === 'preview'
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const previousSize = { width: content.current.offsetWidth, height: content.current.offsetHeight }
    try {
      // Freeze the currently visible layout before the native canvas changes size.
      const visible = shell.current.getBoundingClientRect()
      flushSync(() => {
        setRect({ x: visible.x, y: visible.y, width: visible.width, height: visible.height })
        if (origin === 'expanded') setContentSize(previousSize)
      })
      // Awaiting IPC leaves the renderer responsive while the main process is busy.
      const { from, to } = await window.electronAPI.setWidgetCompact(compact, 'prepare', preview)
      const hovering = origin !== 'expanded' && target !== 'expanded'
      const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
      flushSync(() => {
        if (origin === 'expanded') setContentSize(previousSize)
        else if (target === 'expanded') setContentSize({ width: to.width, height: to.height })
        setRect(from)
        if (hovering) {
          const expanded = preview ? to : from
          const side = dock === 'left' || dock === 'right'
          setPreviewSize({ width: expanded.width - (side ? 38 : dock === 'top' ? 16 : 0),
            height: expanded.height - (side ? 0 : 30) })
        }
        setPhase(origin !== 'expanded' && target !== 'expanded' ? 'peeking' : compact ? 'closing' : 'opening')
      })
      const duration = reducedMotion ? 0 : hovering ? preview ? 560 : 420 : 380
      const samples = hovering && !reducedMotion ? hoverFrames(from, to, preview, duration, dock) : undefined
      const options = { duration, easing: samples ? 'linear' : 'cubic-bezier(.22, 1, .36, 1)', fill: 'both' as const }
      const surface = shell.current!.animate(samples?.surface ?? [frame(from, origin, dock), frame(to, target, dock)], options)
      const fade = content.current!.animate([
        { opacity: origin === 'expanded' ? 1 : 0 },
        { opacity: target === 'expanded' ? 1 : 0 },
      ], { ...options, easing: 'linear' })
      const label = island.current!.animate([
        { opacity: origin === 'expanded' ? 0 : 1 },
        { opacity: target === 'expanded' ? 0 : 1 },
      ], { ...options, easing: 'linear' })
      animations.current = [surface, fade, label]
      if (samples) {
        if (previewContent.current) animations.current.push(previewContent.current.animate(samples.reveal, options))
        if (dock === 'top') animations.current.push(island.current!.animate(samples.corners, { ...options, pseudoElement: '::before' }))
      }
      await surface.finished
      // Keep the final animation frame visible until native clipping is acknowledged.
      const settled = await window.electronAPI.setWidgetCompact(compact, 'finish', preview)
      flushSync(() => settle(target, settled.to))
      if (target === 'preview') scheduleLeave()
      if (target === 'expanded') requestAnimationFrame(() =>
        content.current?.querySelector<HTMLButtonElement>('[data-collapse]')?.focus({ preventScroll: true }))
      // A tray navigation during the animation must still open the full workspace.
      if (target !== 'expanded' && latestView.current !== originView) void morph('expanded')
    } catch (error) {
      console.error('[Window] Panel transition interrupted', error)
      try {
        const settled = await window.electronAPI.setWidgetCompact(compact, 'finish', preview)
        flushSync(() => settle(target, settled.to))
      } catch { flushSync(() => settle(origin)) }
    }
  }
  useEffect(() => {
    if (previousView.current === view) return
    previousView.current = view
    // Only an actual navigation opens the reader, never merely remaining on a bookmark.
    if (!busy.current && mode.current !== 'expanded') void morph('expanded')
  }, [view])

  return <div className="desktop-panel paper-ui" data-phase={phase} data-dock={dock}
    data-island-preview={phase === 'preview' || (['peeking', 'opening', 'closing'].includes(phase) && desired.current === 'preview')}
    data-preview-visible={phase === 'preview' || (busy.current && (mode.current === 'preview' || desired.current === 'preview'))}>
    <div ref={shell} className="paper-morph-surface"
      onMouseEnter={() => clearTimeout(leaveTimer.current)}
      onMouseLeave={() => { clearTimeout(hoverTimer.current); scheduleLeave() }}
      style={rect ? phase === 'expanded' && !busy.current
        ? { left: rect.x, top: rect.y, right: 0, bottom: 0 }
        : { left: rect.x, top: rect.y, width: rect.width, height: rect.height } : undefined}>
      {phase === 'expanded' && ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].map(edge =>
        <div key={edge} className="surface-resize-handle no-drag" data-edge={edge} aria-hidden="true"
          onPointerDown={event => {
            if (event.button !== 0 || busy.current) return
            event.preventDefault()
            event.stopPropagation()
            event.currentTarget.setPointerCapture(event.pointerId)
            resizing.current = true
            void window.electronAPI.resizeSurface('start', edge).catch(error => {
              resizing.current = false
              console.error('[Window] Could not resize', error)
            })
          }}
          onPointerUp={event => {
            if (!resizing.current) return
            resizing.current = false
            void window.electronAPI.resizeSurface('end')
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onLostPointerCapture={() => {
            if (resizing.current) { resizing.current = false; void window.electronAPI.resizeSurface('cancel') }
          }}
          onPointerCancel={() => {
            resizing.current = false
            void window.electronAPI.resizeSurface('cancel')
          }} />)}
      <div ref={content} className="desktop-panel-content" style={contentSize} aria-hidden={phase !== 'expanded'}
        onClick={event => {
          if (phase === 'expanded' && event.target instanceof Element && event.target.closest('[data-collapse]')) void morph('compact')
        }}>{children}</div>
      <div ref={island} className="paper-island-surface" aria-hidden={phase === 'expanded'}>
        <button className="paper-island no-drag" type="button" tabIndex={phase === 'compact' || phase === 'preview' ? 0 : -1}
          aria-label="展开 PaperFeed"
          onMouseEnter={() => {
            if (mode.current === 'compact' && !busy.current && !pointer.current) {
              clearTimeout(hoverTimer.current)
              hoverTimer.current = setTimeout(() => void morph('preview'), 250)
            }
          }}
          onPointerDown={event => {
            if (!['compact', 'preview'].includes(mode.current) || busy.current || releasing.current || event.button !== 0) return
            cancelTimers()
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            pointer.current = { x: event.screenX, y: event.screenY, moved: false }
            void window.electronAPI.dragIsland('start').catch(error => {
              pointer.current = undefined
              console.error('[Island] Could not begin drag', error)
            })
          }}
          onPointerMove={event => {
            const drag = pointer.current
            if (drag && Math.hypot(event.screenX - drag.x, event.screenY - drag.y) > 4) drag.moved = true
          }}
          onPointerUp={async event => {
            const drag = pointer.current
            if (!drag) return
            pointer.current = undefined
            releasing.current = true
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
            try {
              const moved = await window.electronAPI.dragIsland('end')
              releasing.current = false
              if (!moved && !drag.moved) void morph('expanded')
              else if (mode.current === 'preview') {
                // Native dragging finishes at the collapsed size; match the visible state.
                desired.current = 'compact'
                settle('compact')
              }
            } catch (error) {
              releasing.current = false
              console.error('[Island] Could not finish drag', error)
            }
          }}
          onPointerCancel={() => {
            pointer.current = undefined
            void window.electronAPI.dragIsland('cancel')
            scheduleLeave()
          }}
          onLostPointerCapture={() => {
            if (pointer.current) {
              pointer.current = undefined
              void window.electronAPI.dragIsland('cancel')
              scheduleLeave()
            }
          }}
          onClick={event => {
            // Pointer clicks are resolved after native drag completion; keyboard clicks still open.
            if (event.detail === 0 && !releasing.current && !pointer.current) void morph('expanded')
          }}>
          <BookOpen size={15} /><span>PaperFeed</span><ChevronDown size={14} />
        </button>
        <button ref={previewContent} style={previewSize} className="island-preview-content no-drag" type="button"
          tabIndex={phase === 'preview' ? 0 : -1} aria-hidden={phase !== 'preview'}
          onClick={() => void morph('expanded')}>
          <span className="island-preview-meta">{item ? item.journal + ' · ' + item.year : '阅读工作区'}</span>
          <strong>{item ? item.titleCn || item.title : '暂无待阅读文章'}</strong>
          <span className="island-preview-summary">{item ? item.abstractCn || item.abstract || '打开文章查看详情' : '点击打开 PaperFeed'}</span>
          <span className="island-preview-footer">继续阅读<ArrowUpRight size={13} /></span>
        </button>
      </div>
    </div>
  </div>
}
