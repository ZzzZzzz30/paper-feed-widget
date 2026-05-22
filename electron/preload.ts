import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getArticles: (params: { status?: 'new' | 'pushed' | 'bookmarked'; limit?: number; offset?: number }) =>
    ipcRenderer.invoke('articles:get', params),

  recordInteraction: (articleId: number, action: string) =>
    ipcRenderer.invoke('interaction:record', { articleId, action }),
  removeBookmark: (articleId: number) =>
    ipcRenderer.invoke('bookmark:remove', articleId),

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
  closeWindow: () => ipcRenderer.invoke('window:close'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('window:toggleOnTop'),

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
  quickSummary: (articleId: number) => ipcRenderer.invoke('article:quick-summary', articleId),
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
  getTranslationUsage: () => ipcRenderer.invoke('translation:usage') as Promise<{ tencentChars: number; aliyunChars: number; ollamaChars: number; totalChars: number }>,
  getTranslationCloudStatus: () => ipcRenderer.invoke('translation:cloud-status') as Promise<{ tencent: { hasOpen: boolean; hasArrearage: boolean } | null; aliyun: null }>,
  recoverTranslationProvider: (provider: string) => ipcRenderer.invoke('translation:recover', provider),
  resetTranslationStats: (provider: string) => ipcRenderer.invoke('translation:reset-stats', provider),
  getQuotaOverview: () => ipcRenderer.invoke('translation:quota-overview') as Promise<any>,
}

console.log('[Preload] electronAPI keys =', Object.keys(api))
contextBridge.exposeInMainWorld('electronAPI', api)
