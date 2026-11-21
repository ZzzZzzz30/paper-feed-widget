/// <reference types="vite/client" />

export interface JournalConfig {
  name: string
  issn: string
  rssUrl: string
}

export interface JournalCandidate extends JournalConfig {
  publisher: string
}

export interface AppDataInfo {
  currentVersion: string
  dataDirectory: string
}

export interface ArticleNote {
  title: string
  body: string
}

interface ElectronAPI {
  notes: {
    onClosed: (callback: () => void) => () => void
    open: (articleId: number) => Promise<void>
    read: (articleId?: number) => Promise<ArticleNote>
    stage: (body: string, revision: number, articleId?: number) => Promise<void>
    flush: (articleId?: number) => Promise<void>
    remove: (articleId?: number) => Promise<void>
    close: (articleId?: number) => Promise<void>
    onSaveStatus: (callback: (status: { revision: number; articleId?: number; saved: boolean }) => void) => () => void
  }
  getAppDataInfo: () => Promise<AppDataInfo>
  openDataDirectory: () => Promise<{ ok: boolean }>
  discoverJournal: (name: string) => Promise<{ candidates: JournalCandidate[]; exact: boolean }>
  addJournal: (journal: JournalConfig) => Promise<{ added: boolean; journals: JournalConfig[] }>
  getArticles: (params: { status?: 'new' | 'pushed' | 'bookmarked'; limit?: number; offset?: number }) => Promise<Article[]>
  recordInteraction: (articleId: number, action: InteractionAction) => Promise<void>
  removeBookmark: (articleId: number) => Promise<boolean>
  getSettings: () => Promise<Record<string, string>>
  updateSetting: (key: string, value: string) => Promise<{ ok: boolean; configured?: boolean }>
  requestNewPush: () => Promise<PushQueueItem[]>
  requestMorePush?: (excludeIds: number[]) => Promise<PushQueueItem[]>
  getPushQueueSize: () => Promise<number>
  enrichArticle: (articleId: number) => Promise<{ abstract: string; extra_doi: string } | null>
  translateArticle: (articleId: number) => Promise<{ title_cn: string; abstract_cn: string } | null>
  minimizeWindow: () => void
  setWidgetCompact: (compact: boolean, stage: 'prepare' | 'finish', preview?: boolean) => Promise<{
    from: { x: number; y: number; width: number; height: number }
    to: { x: number; y: number; width: number; height: number }
  }>
  onWidgetCompactSettled: (callback: (frame: { x: number; y: number; width: number; height: number }) => void) => () => void
  onWindowSurface: (callback: (layout: { frame: { x: number; y: number; width: number; height: number }; compact?: boolean }) => void) => () => void
  setWorkspaceExpanded: (expanded: boolean) => Promise<void>
  onIslandDock: (callback: (dock: 'top' | 'left' | 'right' | 'free') => void) => () => void
  isIslandHovered: () => Promise<boolean>
  dragIsland: (stage: 'start' | 'move' | 'end' | 'cancel') => Promise<boolean>
  resizeSurface: (stage: 'start' | 'end' | 'cancel', edge?: string) => Promise<void>
  setWindowMaterial: (material: string) => Promise<void>
  closeWindow: () => void
  onNavigate: (callback: (view: string) => void) => void
  onArticleTranslated: (callback: (data: { articleId: number; titleCn: string; abstractCn: string }) => void) => void
  onMetadataUpdated?: (callback: (data: { articleId: number; abstract: string; doi: string }) => void) => void
  quickSummary: (params: { articleId: number; sessionId: number | null }) => Promise<{ sessionId: number; reply: string }>
  analysisChat: (params: { articleId: number; sessionId: number | null; message: string }) => Promise<{ sessionId: number; reply: string }>
  openAnalysisBubble: (payload: { articleId: number; articleTitle: string }) => Promise<boolean>
  getAnalysisSession: (articleId: number) => Promise<{ sessionId: number; messages: Array<{ role: string; content: string }> }>
  onAnalysisBubbleUpdate?: (callback: (data: { articleId: number }) => void) => () => void
  closeAnalysisBubble: () => Promise<boolean>
  getDeepSeekUsage?: () => Promise<{ input: number; output: number; total: number; cost: number }>
  openExternalUrl: (url: string) => Promise<void>
  markArticleRead: (articleId: number) => Promise<{ ok: boolean }>
  markArticleUnread: (articleId: number) => Promise<{ ok: boolean }>
  getReadArticleIds: () => Promise<number[]>
  getBlockedPushIds: () => Promise<number[]>
  savePushState: (payload: { ids: number[]; index: number }) => Promise<{ ok: boolean }>
  loadPushState: () => Promise<{ ids: number[]; index: number } | null>
  getTranslationUsage: () => Promise<{ aliyunChars: number; ollamaChars: number; totalChars: number; ok: boolean; error?: string }>
  recoverTranslationProvider: (provider: string) => Promise<{ ok: boolean }>
  resetTranslationStats: (provider: string) => Promise<{ ok: boolean }>
  getJournals: () => Promise<Array<{ name: string; issn: string; rssUrl: string }>>
  saveJournals: (journals: Array<{ name: string; issn: string; rssUrl: string }>) => Promise<{ ok: boolean }>
  getConferences: () => Promise<Array<{ id: string; name: string; enabled: boolean }>>
  saveConferences: (conferences: Array<{ id: string; name?: string; enabled: boolean }>) => Promise<{ ok: boolean }>
  syncConferences: () => Promise<{ inserted: number; errors: string[] }>
  getQuotaOverview: () => Promise<any>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

// ===== 文章相关类型 =====

export interface Article {
  id: number
  doi: string
  title: string
  abstract: string
  authors: string
  journal: string
  issn: string
  publication_date: string
  year: number
  url: string
  pdf_url: string
  graphical_abstract_url: string
  extra_doi: string
  source_type: 'journal' | 'conference'
  source_key: string | null
  conference_id: string | null
  title_cn: string
  abstract_cn: string
  author_keywords: string
  is_processed: boolean
  is_pushed: boolean
  push_count: number
}

export interface Analysis {
  id: number
  article_id: number
  tldr: string
  research_question: string
  method: string
  innovation: string[] // JSON array parsed
  findings: string
  topics: string[] // JSON array parsed
  limitations: string
  model_used: string
  analyzed_at: string
}

export interface Figure {
  imagePath: string
  caption: string
  figureNumber: number
}

export type InteractionAction =
  | 'dislike'
  | 'bookmark'

export type ActionBarKey = InteractionAction | 'analyze' | 'previous' | 'next'

export interface PushQueueItem {
  articleId: number
  title: string
  titleCn: string
  abstract: string
  abstractCn: string
  doi: string
  url?: string
  tldr: string
  innovation: string[]
  journal: string
  year: number
  score: number
}

export interface UserTopic {
  id: number
  topic: string
  weight: number
  interaction_count: number
}

// ===== 应用状态类型 =====

export type AppView = 'widget' | 'bookmarkDetail' | 'settings' | 'bookmarks'
