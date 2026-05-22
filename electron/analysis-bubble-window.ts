import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'

let bubbleWindow: BrowserWindow | null = null
let currentArticleId: number | null = null
let userMoved = false
let programmaticMove = false

const PW = 434, PH = 334, GAP = 12

function computeBounds(mainWindow: BrowserWindow) {
  const b = mainWindow.getBounds()
  const display = screen.getDisplayMatching(b)
  const work = display.workArea
  const x = Math.max(work.x + 8, b.x - PW - GAP)
  const y = Math.min(Math.max(b.y, work.y + 8), work.y + work.height - PH - 8)
  return { x: Math.round(x), y: Math.round(y), width: PW, height: PH }
}

function setBounds(bounds: Electron.Rectangle) {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return
  programmaticMove = true
  bubbleWindow.setBounds(bounds)
  setTimeout(() => { programmaticMove = false }, 100)
}

function createBubbleWindow(mainWindow: BrowserWindow, payload: { articleId: number; articleTitle: string }): void {
  currentArticleId = payload.articleId
  const bounds = computeBounds(mainWindow)

  bubbleWindow = new BrowserWindow({
    ...bounds, parent: mainWindow, modal: false,
    frame: false, transparent: true, resizable: false, movable: true,
    show: false, skipTaskbar: true, alwaysOnTop: false, focusable: true,
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  bubbleWindow.on('move', () => { if (!programmaticMove) userMoved = true })

  const isDev = !require('electron').app.isPackaged
  const fileUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
  bubbleWindow.loadURL(isDev
    ? `http://localhost:5173/#/analysis-bubble?articleId=${payload.articleId}`
    : `${fileUrl}#/analysis-bubble?articleId=${payload.articleId}`)
  bubbleWindow.once('ready-to-show', () => bubbleWindow?.show())
  bubbleWindow.on('closed', () => {
    mainWindow.removeListener('move', reposition)
    mainWindow.removeListener('resize', reposition)
    bubbleWindow = null; currentArticleId = null; userMoved = false
  })

  const reposition = () => {
    if (!bubbleWindow || bubbleWindow.isDestroyed() || userMoved) return
    setBounds(computeBounds(mainWindow))
  }
  mainWindow.on('move', reposition)
  mainWindow.on('resize', reposition)
  mainWindow.on('closed', () => { if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.close() })
}

export function toggleAnalysisBubble(
  mainWindow: BrowserWindow,
  payload: { articleId: number; articleTitle: string }
): void {
  // 同一篇文章 → 切换显示/隐藏
  if (bubbleWindow && !bubbleWindow.isDestroyed() && currentArticleId === payload.articleId) {
    if (bubbleWindow.isVisible()) {
      bubbleWindow.close()
    } else {
      bubbleWindow.show()
      bubbleWindow.focus()
    }
    return
  }

  // 不同文章或窗口已关闭 → 先清理旧窗口
  if (bubbleWindow && !bubbleWindow.isDestroyed()) {
    const old = bubbleWindow
    bubbleWindow = null
    currentArticleId = null
    old.once('closed', () => createBubbleWindow(mainWindow, payload))
    old.close()
    return
  }

  // 无窗口 → 新建
  createBubbleWindow(mainWindow, payload)
}

export function closeAnalysisBubble(): void {
  if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.close()
  bubbleWindow = null; currentArticleId = null; userMoved = false
}
