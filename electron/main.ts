// 加载 .env.local（优先级高于系统环境变量）
const fs = require('fs')
const path = require('path')
const envPath = path.join(__dirname, '..', '..', '.env.local')
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n').filter((l: string) => l.trim() && !l.startsWith('#'))
  for (const line of lines) {
    const [k, ...rest] = line.split('=')
    const v = rest.join('=')
    if (k && v && !process.env[k.trim()]) {
      process.env[k.trim()] = v.trim()
    }
  }
}

import { app, BrowserWindow, Tray, dialog, ipcMain, shell } from 'electron'
import { configureDataDirectory } from './services/data-directory'

// 安装版和开发版使用固定且互不干扰的数据目录。
configureDataDirectory()

// 单实例锁
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
  process.exit(0)
}

// widgetWindow 在模块作用域声明，用于 second-instance 聚焦
let _widgetWindow: BrowserWindow | null = null

app.on('second-instance', () => {
  if (_widgetWindow && !_widgetWindow.isDestroyed()) {
    if (_widgetWindow.isMinimized()) _widgetWindow.restore()
    _widgetWindow.show()
    _widgetWindow.moveTop()
    _widgetWindow.focus()
  }
})
import { createWidgetWindow } from './window'
import { createTray } from './tray'
import { initDatabase, saveNow } from './services/db'
import { registerIpcHandlers } from './ipc-handlers'
import { startScheduler } from './services/fetcher'
import { startConferenceScheduler } from './services/conference-fetcher'
import { startPrecacheWorkers } from './services/precache'
import { startRefillWorker } from './services/refill'
import { migrateSecretSettings } from './services/secure-settings'
import { flushNotes, registerNotesIpc } from './services/notes'

let widgetWindow: BrowserWindow | null = null
let tray: Tray | null = null

app.whenReady().then(async () => {
  await initDatabase()
  try {
    migrateSecretSettings()
  } catch (error) {
    console.error('[Secrets] Secure migration failed; refusing to start with plaintext credentials', error)
    dialog.showErrorBox('API 密钥迁移失败', '系统安全存储不可用，无法加密现有 API 密钥。请检查系统密钥库后重新启动 PaperFeed。')
    app.quit()
    return
  }

  widgetWindow = createWidgetWindow()
  _widgetWindow = widgetWindow
  registerIpcHandlers(widgetWindow)
  registerNotesIpc(widgetWindow)
  tray = createTray(widgetWindow)
  ipcMain.handle('app:data-info', () => ({
    currentVersion: app.getVersion(),
    dataDirectory: app.getPath('userData'),
  }))
  ipcMain.handle('app:open-data-directory', async () => {
    const error = await shell.openPath(app.getPath('userData'))
    if (error) throw new Error(error)
    return { ok: true }
  })

  // 启动定时抓取任务
  startScheduler()
  startConferenceScheduler()

  // 启动持续后台预缓存（摘要 + 翻译）
  startPrecacheWorkers()

  // 启动自动补货（剩余不足时抓更多文章）
  startRefillWorker()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      widgetWindow = createWidgetWindow()
      if (widgetWindow) {
        registerIpcHandlers(widgetWindow)
        registerNotesIpc(widgetWindow)
      }
    }
  })
})

app.on('window-all-closed', () => {
  // 不退出应用，保持在托盘运行
})

process.on('uncaughtException', err => console.error('[Main uncaughtException]', err))
process.on('unhandledRejection', err => console.error('[Main unhandledRejection]', err))

app.on('before-quit', (event) => {
  try {
    flushNotes()
  } catch {
    event.preventDefault()
    ;(app as typeof app & { isQuitting?: boolean }).isQuitting = false
    dialog.showErrorBox('笔记保存失败', '请检查数据目录是否可写，然后重试保存或退出。')
    return
  }
  ;(app as typeof app & { isQuitting?: boolean }).isQuitting = true
  saveNow()
})
