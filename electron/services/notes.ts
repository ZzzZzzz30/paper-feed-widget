import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from './db'

interface Article {
  id: number
  title: string
  title_cn: string | null
}

let active: { window: BrowserWindow; article: Article; draft?: string; revision: number } | undefined
let saveTimer: ReturnType<typeof setTimeout> | undefined

function notePath(articleId: number): string {
  return path.join(app.getPath('userData'), 'notes', 'articles', articleId + '.md')
}

function readBody(articleId: number): string {
  try {
    return fs.readFileSync(notePath(articleId), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

export function flushNotes(): void {
  clearTimeout(saveTimer)
  saveTimer = undefined
  if (!active || active.draft === undefined) return
  const { article, draft, revision, window } = active
  const file = notePath(article.id)
  try {
    if (draft.trim()) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const temp = file + '.' + randomUUID() + '.tmp'
      try {
        fs.writeFileSync(temp, draft, { encoding: 'utf8', flag: 'wx' })
        fs.renameSync(temp, file)
      } finally {
        fs.rmSync(temp, { force: true })
      }
    } else {
      fs.rmSync(file, { force: true })
    }
    active.draft = undefined
  } catch (error) {
    if (!window.webContents.isDestroyed()) window.webContents.send('notes:save-status', { revision, articleId: article.id, saved: false })
    throw error
  }
  if (!window.webContents.isDestroyed()) window.webContents.send('notes:save-status', { revision, articleId: article.id, saved: true })
}

function openNote(mainWindow: BrowserWindow, articleId: number): void {
  if (!Number.isSafeInteger(articleId) || articleId <= 0) throw new Error('Invalid article ID')
  if (active?.article.id === articleId) return
  const article = getDb().prepare('SELECT id, title, title_cn FROM articles WHERE id = ?').get(articleId) as Article | undefined
  if (!article) throw new Error('Article not found')
  flushNotes()
  active = { window: mainWindow, article, revision: 0 }
}

function authorizeEditor(event: IpcMainInvokeEvent, articleId?: number) {
  if (!active || event.sender !== active.window.webContents || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Invalid notes window')
  }
  if (articleId !== undefined && articleId !== active.article.id) throw new Error('Note article changed')
  return active
}

export function registerNotesIpc(mainWindow: BrowserWindow): void {
  ipcMain.removeHandler('notes:open')
  ipcMain.handle('notes:open', (event, articleId: number) => {
    if (event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Notes must be opened from the article window')
    }
    openNote(mainWindow, articleId)
  })
  for (const channel of ['read', 'stage', 'flush', 'remove', 'close']) ipcMain.removeHandler('notes:' + channel)
  ipcMain.handle('notes:read', (event, articleId?: number) => {
    const { article, draft } = authorizeEditor(event, articleId)
    return { title: article.title_cn || article.title, body: draft ?? readBody(article.id) }
  })
  ipcMain.handle('notes:stage', (event, body: string, revision: number, articleId?: number) => {
    const note = authorizeEditor(event, articleId)
    if (typeof body !== 'string' || !Number.isSafeInteger(revision) || revision <= note.revision) {
      throw new Error('Invalid note revision')
    }
    note.draft = body
    note.revision = revision
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      try { flushNotes() } catch (error) { console.error('[Notes] Could not autosave', error) }
    }, 1000)
  })
  ipcMain.handle('notes:flush', (event, articleId?: number) => {
    authorizeEditor(event, articleId)
    flushNotes()
  })
  ipcMain.handle('notes:remove', (event, articleId?: number) => {
    const note = authorizeEditor(event, articleId)
    fs.rmSync(notePath(note.article.id), { force: true })
    note.draft = undefined
    clearTimeout(saveTimer)
    active = undefined
    note.window.webContents.send('notes:closed')
  })
  ipcMain.handle('notes:close', (event, articleId?: number) => {
    const note = authorizeEditor(event, articleId)
    flushNotes()
    active = undefined
    note.window.webContents.send('notes:closed')
  })
}
