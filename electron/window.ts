import { BrowserWindow, screen } from 'electron'
import path from 'path'



type Rect = Electron.Rectangle
interface Morph { target: Rect; from: Rect; to: Rect; timer: ReturnType<typeof setTimeout> }
const readingBounds = new WeakMap<BrowserWindow, Rect>()
const islandBounds = new WeakMap<BrowserWindow, Rect>()
const compactWindows = new WeakSet<BrowserWindow>()
const workspaceBounds = new WeakMap<BrowserWindow, Rect>()
const morphs = new WeakMap<BrowserWindow, Morph>()
const materials = new WeakMap<BrowserWindow, string>()
const surfaceOffsets = new WeakMap<BrowserWindow, { x: number; y: number }>()
function surfaceRect(win: BrowserWindow): Rect {
  const b = win.getBounds(), offset = surfaceOffsets.get(win) ?? { x: 0, y: 0 }
  return { ...offset, width: b.width - offset.x, height: b.height - offset.y }
}
function visibleBounds(win: BrowserWindow): Rect {
  const b = win.getBounds(), r = surfaceRect(win)
  return { ...r, x: b.x + r.x, y: b.y + r.y }
}
function clipSurface(win: BrowserWindow): void {
  // Exclude the transparent canvas padding from both painting and mouse hit testing.
  if (process.platform === 'win32') win.setShape([surfaceRect(win)])
}
function placeSurface(win: BrowserWindow, target: Rect): void {
  const current = win.getBounds()
  const x = Math.min(current.x, target.x), y = Math.min(current.y, target.y)
  const canvas = { x, y, width: target.x + target.width - x, height: target.y + target.height - y }
  win.setMinimumSize(1, 1)
  win.setMaximumSize(Math.max(canvas.width, current.width), Math.max(canvas.height, current.height))
  surfaceOffsets.set(win, { x: target.x - x, y: target.y - y })
  win.setBounds(canvas)
  clipSurface(win)
}
function restoreSizeLimits(win: BrowserWindow, compact: boolean): void {
  const b = win.getBounds(), offset = surfaceOffsets.get(win) ?? { x: 0, y: 0 }
  if (compact) { win.setMinimumSize(b.width, b.height); win.setMaximumSize(b.width, b.height); return }
  const work = screen.getDisplayMatching(visibleBounds(win)).workArea
  win.setMaximumSize(maxWidth(win) + offset.x, 1000 + offset.y)
  win.setMinimumSize((workspaceBounds.has(win) ? Math.min(700, work.width - 24) : 320) + offset.x, 480 + offset.y)
}
// The visible surface can be inset from the native window after an island animation.
// Resize that surface explicitly so its top/left edges remain reachable.
const resizes = new WeakMap<BrowserWindow, {
  bounds: Rect; cursor: Electron.Point; edge: string; started: number;
  timer: ReturnType<typeof setInterval>; cleanup: () => void
}>()
function moveResize(win: BrowserWindow): void {
  const resize = resizes.get(win)
  if (!resize || win.isDestroyed()) return
  const p = screen.getCursorScreenPoint(), b = resize.bounds
  const dx = p.x - resize.cursor.x, dy = p.y - resize.cursor.y
  const work = screen.getDisplayMatching(b).workArea
  const minWidth = workspaceBounds.has(win) ? Math.min(700, work.width - 24) : 320
  const width = clamp(b.width + (resize.edge.includes('w') ? -dx : resize.edge.includes('e') ? dx : 0), minWidth, maxWidth(win))
  const height = clamp(b.height + (resize.edge.includes('n') ? -dy : resize.edge.includes('s') ? dy : 0), 480, 1000)
  const target = { x: resize.edge.includes('w') ? b.x + b.width - width : b.x,
    y: resize.edge.includes('n') ? b.y + b.height - height : b.y, width, height }
  const current = visibleBounds(win)
  if (current.x === target.x && current.y === target.y && current.width === width && current.height === height) return
  placeSurface(win, target)
  win.webContents.send('window:surface', { frame: surfaceRect(win) })
}
export function resizeSurface(win: BrowserWindow, stage: string, edge = ''): void {
  if (stage === 'start') {
    if (compactWindows.has(win) || morphs.has(win) || resizes.has(win)) return
    if (!['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].includes(edge)) throw new Error('Invalid resize edge')
    const cleanup = () => {
      const resize = resizes.get(win)
      if (resize) clearInterval(resize.timer)
      resizes.delete(win)
      win.removeListener('closed', cleanup)
      win.removeListener('blur', cleanup)
      if (!win.isDestroyed()) restoreSizeLimits(win, false)
    }
    const timer = setInterval(() => {
      const resize = resizes.get(win)
      if (win.isDestroyed() || !resize || Date.now() - resize.started > 60_000) { cleanup(); return }
      moveResize(win)
    }, 16)
    resizes.set(win, { bounds: visibleBounds(win), cursor: screen.getCursorScreenPoint(), edge,
      started: Date.now(), timer, cleanup })
    win.once('closed', cleanup)
    win.once('blur', cleanup)
    return
  }
  const resize = resizes.get(win)
  if (!resize) return
  if (stage === 'end') moveResize(win)
  resize.cleanup()
}
const drags = new WeakMap<BrowserWindow, {
  bounds: Rect; cursor: Electron.Point; moved: boolean; started: number;
  timer: ReturnType<typeof setInterval>; cleanup: () => void
}>()
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, hi))
function maxWidth(win: BrowserWindow) { return workspaceBounds.has(win) ? 1400 : 560 }
function fit(rect: Rect, work: Rect, margin = 12): Rect {
  const width = Math.min(rect.width, work.width - margin * 2)
  const height = Math.min(rect.height, work.height - margin * 2)
  return { width, height, x: clamp(rect.x, work.x + margin, work.x + work.width - width - margin),
    y: clamp(rect.y, work.y + margin, work.y + work.height - height - margin) }
}

export function setWorkspaceExpanded(win: BrowserWindow, expanded: boolean): void {
  if (morphs.has(win) || compactWindows.has(win)) throw new Error('请等待窗口展开后再操作')
  const current = visibleBounds(win), work = screen.getDisplayMatching(current).workArea
  if (expanded === workspaceBounds.has(win)) return
  if (expanded) {
    workspaceBounds.set(win, current)
    placeSurface(win, fit({ ...current, width: current.width + 440 }, work))
  } else {
    const original = workspaceBounds.get(win)!
    workspaceBounds.delete(win)
    placeSurface(win, fit({ ...current, width: original.width }, work))
  }
  restoreSizeLimits(win, false)
  win.webContents.send('window:surface', { frame: surfaceRect(win) })
}

export function setWindowMaterial(win: BrowserWindow, material: string): void {
  if (!['solid', 'paper', 'frosted', 'smoked'].includes(material)) throw new Error('Invalid material')
  materials.set(win, material)
  if (process.platform === 'win32') {
    // DWM acrylic paints outside the transparent window's CSS corners even with setShape.
    // All presets use the renderer's clipped translucent surfaces instead.
    win.setBackgroundMaterial('none')
  }
}

export function isIslandHovered(win: BrowserWindow): boolean {
  const p = screen.getCursorScreenPoint(), b = visibleBounds(win)
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
}


type Dock = 'top' | 'left' | 'right' | 'free'
function dockForRect(rect: Rect, work: Rect): Dock {
  return Math.abs(rect.y - work.y) <= 2 ? 'top' :
    Math.abs(rect.x - work.x) <= 2 ? 'left' :
    Math.abs(rect.x + rect.width - work.x - work.width) <= 2 ? 'right' : 'free'
}
function islandSize(dock: Dock, work: Rect): Pick<Rect, 'width' | 'height'> {
  if (dock === 'left' || dock === 'right') {
    return { width: Math.min(38, work.width), height: Math.min(220, work.height) }
  }
  return { width: Math.min(220, work.width), height: Math.min(30, work.height) }
}
function publishIslandDock(win: BrowserWindow) {
  const b = islandBounds.get(win) ?? visibleBounds(win), w = screen.getDisplayMatching(b).workArea
  const dock = dockForRect(b, w)
  win.webContents.send('window:island-dock', dock)
}
function moveIsland(win: BrowserWindow): void {
  const drag = drags.get(win)
  if (!drag || win.isDestroyed()) return
  const cursor = screen.getCursorScreenPoint()
  const dx = cursor.x - drag.cursor.x, dy = cursor.y - drag.cursor.y
  if (!drag.moved && Math.hypot(dx, dy) < 4) return
  drag.moved = true
  const work = screen.getDisplayNearestPoint(cursor).workArea
  const offset = surfaceOffsets.get(win) ?? { x: 0, y: 0 }
  const x = clamp(drag.bounds.x + dx, work.x, work.x + work.width - drag.bounds.width)
  const y = clamp(drag.bounds.y + dy, work.y, work.y + work.height - drag.bounds.height)
  win.setPosition(Math.round(x - offset.x), Math.round(y - offset.y))
}
export function dragIsland(win: BrowserWindow, stage: string): boolean {
  if (stage === 'start') {
    if (!compactWindows.has(win) || morphs.has(win)) return false
    const previous = drags.get(win)
    if (previous) { clearInterval(previous.timer); win.removeListener('closed', previous.cleanup) }
    const cleanup = () => {
      const drag = drags.get(win)
      if (drag) clearInterval(drag.timer)
      drags.delete(win)
    }
    const timer = setInterval(() => {
      const drag = drags.get(win)
      if (win.isDestroyed()) { cleanup(); return }
      if (!drag || Date.now() - drag.started > 60_000) { dragIsland(win, 'cancel'); return }
      moveIsland(win)
    }, 16)
    drags.set(win, { bounds: visibleBounds(win), cursor: screen.getCursorScreenPoint(),
      moved: false, started: Date.now(), timer, cleanup })
    win.once('closed', cleanup)
    return false
  }
  const drag = drags.get(win)
  if (!drag) return false
  moveIsland(win)
  if (stage === 'move') return drag.moved
  clearInterval(drag.timer)
  win.removeListener('closed', drag.cleanup)
  drags.delete(win)
  if (drag.moved) {
    const b = visibleBounds(win), work = screen.getDisplayMatching(b).workArea
    const edges = [
      { edge: 'top', distance: b.y - work.y },
      { edge: 'left', distance: b.x - work.x },
      { edge: 'right', distance: work.x + work.width - b.x - b.width },
    ].sort((a, b) => a.distance - b.distance)
    const edge = edges[0].distance <= 32 ? edges[0].edge : 'free'
    const size = islandSize(edge as Dock, work)
    const width = size.width, height = size.height
    const x = edge === 'left' ? work.x : edge === 'right' ? work.x + work.width - width :
      clamp(b.x + (b.width - width) / 2, work.x, work.x + work.width - width)
    const y = edge === 'top' ? work.y :
      clamp(b.y + (b.height - height) / 2, work.y, work.y + work.height - height)
    placeSurface(win, { x: Math.round(x), y: Math.round(y), width, height })
    restoreSizeLimits(win, true)
    islandBounds.set(win, visibleBounds(win))
    publishIslandDock(win)
    win.webContents.send('window:surface', { frame: surfaceRect(win), compact: true })
  }
  return drag.moved
}

export function setWidgetCompact(win: BrowserWindow, compact: boolean, stage: 'prepare' | 'finish' = 'prepare', preview = false) {
  const pending = morphs.get(win)
  if (stage === 'finish') {
    if (pending) {
      clearTimeout(pending.timer)
      // Keep the native origin: moving the HWND would move its previous bitmap for a frame.
      placeSurface(win, pending.target)
      morphs.delete(win)
    }
    if (compact || preview) {
      compactWindows.add(win)
      const bounds = visibleBounds(win)
      if (compact) islandBounds.set(win, bounds)
    } else {
      compactWindows.delete(win)
    }
    restoreSizeLimits(win, compact || preview)
    win.setMovable(true)
    // Keep the island and hover preview accessible; the reading window stacks normally.
    if (win.isAlwaysOnTop() !== (compact || preview)) win.setAlwaysOnTop(compact || preview)
    if (compact || preview) publishIslandDock(win)
    return { from: surfaceRect(win), to: surfaceRect(win) }
  }
  if (pending) return { from: pending.from, to: pending.to }
  const current = visibleBounds(win)
  const native = win.getBounds()
  const work = screen.getDisplayMatching(current).workArea
  if (compact && !compactWindows.has(win)) readingBounds.set(win, current)
  const reading = readingBounds.get(win) ?? { ...current, width: 440, height: 640 }
  let target: Rect
  if (compact) {
    target = islandBounds.get(win) ?? { x: Math.round(current.x + (current.width - 220) / 2), y: work.y, width: 220, height: 30 }
    if (!islandBounds.has(win)) target = { ...target, ...islandSize('top', work) }
    target = fit(target, screen.getDisplayMatching(target).workArea, 0)
  } else if (preview) {
    const anchor = islandBounds.get(win) ?? current
    const dock = dockForRect(anchor, work)
    // The preview grows toward the screen interior while keeping the attached edge stable.
    target = dock === 'left'
      ? { x: anchor.x, y: anchor.y, width: 360, height: 260 }
      : dock === 'right'
        ? { x: anchor.x + anchor.width - 360, y: anchor.y, width: 360, height: 260 }
        : { x: Math.round(anchor.x + (anchor.width - 360) / 2), y: anchor.y, width: 360, height: 176 }
    target = fit(target, work, 0)
  } else {
    target = fit(reading, screen.getDisplayMatching(reading).workArea)
  }
  const canvas = {
    x: Math.min(native.x, target.x), y: Math.min(native.y, target.y),
    width: Math.max(native.x + native.width, target.x + target.width) - Math.min(native.x, target.x),
    height: Math.max(native.y + native.height, target.y + target.height) - Math.min(native.y, target.y),
  }
  win.setMovable(false)
  win.setMinimumSize(1, 1)
  win.setMaximumSize(Math.max(maxWidth(win), canvas.width), Math.max(1000, canvas.height))
  win.setBounds(canvas)
  if (process.platform === 'win32') win.setShape([])
  const actual = win.getContentBounds()
  const local = (r: Rect): Rect => ({ ...r, x: r.x - actual.x, y: r.y - actual.y })
  const from = local(current), to = local(target)
  const timer = setTimeout(() => {
    if (!win.isDestroyed()) {
      const settled = setWidgetCompact(win, compact, 'finish', preview)
      win.webContents.send('window:compact-settled', settled.to)
    }
  }, 5000)
  morphs.set(win, { target, from, to, timer })
  return { from, to }
}

function isDev(): boolean {
  return process.env.NODE_ENV === 'development' || !require('electron').app.isPackaged
}

export function createWidgetWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 440,
    height: 640,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    movable: true,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: false,
    skipTaskbar: true,
    minWidth: 320,
    minHeight: 480,
    maxWidth: 500,
    maxHeight: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const primaryDisplay = screen.getPrimaryDisplay()
  win.on('resize', () => {
    if (!morphs.has(win) && !drags.has(win) && !resizes.has(win) && win.isMovable() && !compactWindows.has(win)) clipSurface(win)
  })
  const work = primaryDisplay.workArea
  const x = Math.max(work.x, work.x + work.width - win.getBounds().width - 16)
  const y = Math.max(work.y, Math.min(work.y + work.height - win.getBounds().height, work.y + Math.round(work.height * 0.1)))
  win.setPosition(x, y)

  win.webContents.on('console-message', (_event, level, message) => {
    const prefix = level >= 3 ? '[RENDER-ERR]' : '[RENDER]'
    console.log(`${prefix} ${message}`)
  })

  // 根因修复：拦截 ESC 键防止 Chromium 关闭窗口
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      // 吞咽 ESC 键，不让 Chromium 处理
      _event.preventDefault()
    }
  })

  // 阻止真正关闭（托盘退出时由 main.ts 处理）
  win.on('close', (e) => {
    const { app } = require('electron')
    if (!app.isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })

  if (isDev()) {
    loadDevServer(win, 'http://localhost:5173')
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  win.webContents.on('did-finish-load', () => {
    console.log('[Window] did-finish-load', {
      bounds: win.getBounds(),
      contentBounds: win.getContentBounds(),
      zoomFactor: win.webContents.getZoomFactor(),
    })
  })

  return win
}

function loadDevServer(win: BrowserWindow, url: string, retries = 30): void {
  let attempt = 0
  const tryLoad = () => {
    attempt++
    fetch(url + '/@vite/client', { method: 'HEAD' })
      .then(() => {
        console.log('[Window] Vite 就绪，加载页面')
        win.loadURL(url)
      })
      .catch(() => {
        if (attempt < retries) {
          console.log(`[Window] 等待 Vite 启动... (${attempt}/${retries})`)
          setTimeout(tryLoad, 1000)
        } else {
          console.error('[Window] Vite 超时，尝试直接加载')
          win.loadURL(url)
        }
      })
  }
  tryLoad()
}
