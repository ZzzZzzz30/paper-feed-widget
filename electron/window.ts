import { BrowserWindow } from 'electron'
import path from 'path'

function isDev(): boolean {
  return process.env.NODE_ENV === 'development' || !require('electron').app.isPackaged
}

export function createWidgetWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 384,
    height: 604,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    movable: true,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
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

  const { screen } = require('electron')
  const primaryDisplay = screen.getPrimaryDisplay()
  const x = primaryDisplay.workAreaSize.width - 390
  const y = Math.floor(primaryDisplay.workAreaSize.height * 0.1)
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

  // 失焦后重设置顶（微信截图等外部工具会抢走焦点并改变窗口层级）
  win.on('blur', () => {
    if (!win.isDestroyed()) {
      win.setAlwaysOnTop(true)
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
