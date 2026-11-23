import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getArticleStatistics: () => ipcRenderer.invoke('articles:statistics'),
  getArticles: (params: { status?: 'new' | 'pushed' | 'bookmarked'; limit?: number; offset?: number }) =>
    ipcRenderer.invoke('articles:get', params),

  recordInteraction: (articleId: number, action: string) =>
    ipcRenderer.invoke('interaction:record', { articleId, action }),
  removeBookmark: (articleId: number) =>
    ipcRenderer.invoke('bookmark:remove', articleId),

  notes: {
    onClosed: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('notes:closed', listener)
      return () => ipcRenderer.removeListener('notes:closed', listener)
    },
    open: (articleId: number) => ipcRenderer.invoke('notes:open', articleId),
    read: (articleId?: number) => ipcRenderer.invoke('notes:read', articleId),
    stage: (body: string, revision: number, articleId?: number) => ipcRenderer.invoke('notes:stage', body, revision, articleId),
    flush: (articleId?: number) => ipcRenderer.invoke('notes:flush', articleId),
    remove: (articleId?: number) => ipcRenderer.invoke('notes:remove', articleId),
    close: (articleId?: number) => ipcRenderer.invoke('notes:close', articleId),
    onSaveStatus: (callback: (status: { revision: number; articleId?: number; saved: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: Parameters<typeof callback>[0]) => callback(status)
      ipcRenderer.on('notes:save-status', handler)
      return () => { ipcRenderer.removeListener('notes:save-status', handler) }
    },
  },

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSetting: (key: string, value: string) =>
    ipcRenderer.invoke('settings:update', { key, value }),

  requestNewPush: () => ipcRenderer.invoke('push:request'),
  requestMorePush: (excludeIds: number[]) => ipcRenderer.invoke('push:more', excludeIds),
  getPushQueueSize: () => ipcRenderer.invoke('push:queueSize'),

  enrichArticle: (articleId: number) =>
    ipcRenderer.invoke('article:enrich', articleId),
  translateArticle: (articleId: number) =>
    ipcRenderer.invoke('article:translate', articleId),

  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  setWidgetCompact: (compact: boolean, stage: 'prepare' | 'finish', preview = false) => ipcRenderer.invoke('window:set-compact', compact, stage, preview),
  onWidgetCompactSettled: (callback: (frame: Electron.Rectangle) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, frame: Electron.Rectangle) => callback(frame)
    ipcRenderer.on('window:compact-settled', listener)
    return () => ipcRenderer.removeListener('window:compact-settled', listener)
  },
  onWindowSurface: (callback: (layout: { frame: Electron.Rectangle; compact?: boolean }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, layout: { frame: Electron.Rectangle; compact?: boolean }) => callback(layout)
    ipcRenderer.on('window:surface', listener)
    return () => ipcRenderer.removeListener('window:surface', listener)
  },
  setWorkspaceExpanded: (expanded: boolean) => ipcRenderer.invoke('window:workspace', expanded),
  onIslandDock: (callback: (dock: 'top' | 'left' | 'right' | 'free') => void) => {
    const listener = (_event: Electron.IpcRendererEvent, dock: 'top' | 'left' | 'right' | 'free') => callback(dock)
    ipcRenderer.on('window:island-dock', listener)
    return () => ipcRenderer.removeListener('window:island-dock', listener)
  },
  isIslandHovered: () => ipcRenderer.invoke('window:island-hovered'),
  dragIsland: (stage: 'start' | 'move' | 'end' | 'cancel') => ipcRenderer.invoke('window:island-drag', stage),
  resizeSurface: (stage: 'start' | 'end' | 'cancel', edge = '') => ipcRenderer.invoke('window:resize-surface', stage, edge),
  setWindowMaterial: (material: string) => ipcRenderer.invoke('window:material', material),
  closeWindow: () => ipcRenderer.invoke('window:close'),

  // 托盘导航
  onNavigate: (callback: (view: string) => void) => {
    ipcRenderer.on('navigate', (_event, view: string) => callback(view))
  },
  onArticleTranslated: (callback: (data: { articleId: number; titleCn: string; abstractCn: string }) => void) => {
    ipcRenderer.on('article:translated', (_event, data) => callback(data))
  },
  onMetadataUpdated: (callback: (data: { articleId: number; abstract: string; doi: string }) => void) => {
    ipcRenderer.on('article:metadata-updated', (_event, data) => callback(data))
  },
  quickSummary: (params: { articleId: number; sessionId: number | null }) => ipcRenderer.invoke('article:quick-summary', params),
  analysisChat: (params: { articleId: number; sessionId: number | null; message: string }) => ipcRenderer.invoke('analysis:chat', params),
  openAnalysisBubble: (payload: { articleId: number; articleTitle: string }) => ipcRenderer.invoke('analysis-bubble:toggle', payload),
  getAnalysisSession: (articleId: number) => ipcRenderer.invoke('analysis:get-session', articleId),
  closeAnalysisBubble: () => ipcRenderer.invoke('analysis-bubble:close'),
  onAnalysisBubbleUpdate: (callback: (data: { articleId: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { articleId: number }) => callback(data)
    ipcRenderer.on('analysis-bubble:update', handler)
    return () => { ipcRenderer.removeListener('analysis-bubble:update', handler) }
  },
  getDeepSeekUsage: () => ipcRenderer.invoke('deepseek:usage'),
  openExternalUrl: (url: string) => ipcRenderer.invoke('open:external-url', url),
  markArticleRead: (articleId: number) => ipcRenderer.invoke('article:mark-read', articleId),
  markArticleUnread: (articleId: number) => ipcRenderer.invoke('article:mark-unread', articleId),
  getReadArticleIds: () => ipcRenderer.invoke('article:get-read-ids') as Promise<number[]>,
  getBlockedPushIds: () => ipcRenderer.invoke('push:get-blocked-ids') as Promise<number[]>,
  savePushState: (payload: { ids: number[]; index: number }) => ipcRenderer.invoke('push:save-state', payload),
  loadPushState: () => ipcRenderer.invoke('push:load-state') as Promise<{ ids: number[]; index: number } | null>,
  getTranslationUsage: () => ipcRenderer.invoke('translation:usage') as Promise<{ aliyunChars: number; ollamaChars: number; totalChars: number }>,
  recoverTranslationProvider: (provider: string) => ipcRenderer.invoke('translation:recover', provider),
  resetTranslationStats: (provider: string) => ipcRenderer.invoke('translation:reset-stats', provider),
  getAppDataInfo: () => ipcRenderer.invoke('app:data-info'),
  openDataDirectory: () => ipcRenderer.invoke('app:open-data-directory'),
  discoverJournal: (name: string) => ipcRenderer.invoke('journals:discover', name),
  addJournal: (journal: { name: string; issn: string; rssUrl: string }) => ipcRenderer.invoke('journals:add', journal),
  getJournals: () => ipcRenderer.invoke('journals:get') as Promise<Array<{ name: string; issn: string; rssUrl: string }>>,
  saveJournals: (journals: Array<{ name: string; issn: string; rssUrl: string }>) => ipcRenderer.invoke('journals:save', journals),
  getConferences: () => ipcRenderer.invoke('conferences:get') as Promise<Array<{ id: string; name: string; enabled: boolean }>>,
  saveConferences: (conferences: Array<{ id: string; name?: string; enabled: boolean }>) => ipcRenderer.invoke('conferences:save', conferences),
  syncConferences: () => ipcRenderer.invoke('conferences:sync') as Promise<{ inserted: number; errors: string[] }>,
  getQuotaOverview: () => ipcRenderer.invoke('translation:quota-overview') as Promise<any>,
}

console.log('[Preload] electronAPI keys =', Object.keys(api))
contextBridge.exposeInMainWorld('electronAPI', api)
