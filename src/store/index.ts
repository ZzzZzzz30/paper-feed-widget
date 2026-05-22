import { create } from 'zustand'
import type { PushQueueItem, AppView } from '../types'

interface AppState {
  // 当前视图
  view: AppView
  previousView: AppView
  setView: (view: AppView) => void

  // 推送队列
  queue: PushQueueItem[]
  currentIndex: number
  // 保存推送队列（进入收藏详情时不丢失推送状态）
  savedPushQueue: PushQueueItem[]
  savedPushIndex: number
  savePushState: () => void
  restorePushState: () => void
  setQueue: (queue: PushQueueItem[]) => void
  restoreQueue: (queue: PushQueueItem[], index: number) => void
  appendQueue: (items: PushQueueItem[]) => void
  removeFromQueue: (articleId: number) => void
  setCurrentIndex: (index: number) => void
  advanceQueue: () => void
  goBack: () => void
  advanceCircular: () => boolean
  goBackCircular: () => boolean
  updateQueueItem: (index: number, updates: Partial<PushQueueItem>) => void

  // 收藏已读状态
  bookmarkReadIds: Set<number>
  setBookmarkReadIds: (ids: number[]) => void
  toggleBookmarkRead: (id: number) => void

  // 当前查看的文章
  currentArticleId: number | null
  setCurrentArticleId: (id: number | null) => void

  // 加载状态
  isLoading: boolean
  setIsLoading: (loading: boolean) => void

  // 设置
  settings: Record<string, string>
  setSettings: (settings: Record<string, string>) => void
  updateSetting: (key: string, value: string) => void
}

export const useStore = create<AppState>((set) => ({
  view: 'widget',
  previousView: 'widget',
  setView: (view) => set((state) => {
    // 只在离开推送视图时保存，离开收藏详情时不保存（防止覆盖推送状态）
    if (state.view === 'widget' && view !== 'widget') {
      return { view, previousView: state.view, savedPushQueue: state.queue, savedPushIndex: state.currentIndex }
    }
    return { view, previousView: state.view }
  }),

  queue: [],
  currentIndex: 0,
  savedPushQueue: [],
  savedPushIndex: 0,
  savePushState: () => set((state) => ({ savedPushQueue: state.queue, savedPushIndex: state.currentIndex })),
  restorePushState: () => set((state) => ({ queue: state.savedPushQueue, currentIndex: state.savedPushIndex })),
  setQueue: (queue) => set({ queue, currentIndex: 0 }),
  restoreQueue: (queue, index) =>
    set({
      queue,
      currentIndex: Math.min(Math.max(0, index), Math.max(0, queue.length - 1)),
    }),
  appendQueue: (items) => set((state) => ({ queue: [...state.queue, ...items] })),
  removeFromQueue: (articleId: number) => set((state) => {
    const newQueue = state.queue.filter(it => it.articleId !== articleId)
    const newSaved = state.savedPushQueue.filter(it => it.articleId !== articleId)
    const newIndex = Math.min(state.currentIndex, Math.max(0, newQueue.length - 1))
    const newSavedIndex = Math.min(state.savedPushIndex, Math.max(0, newSaved.length - 1))
    return { queue: newQueue, savedPushQueue: newSaved, currentIndex: newIndex, savedPushIndex: newSavedIndex }
  }),
  setCurrentIndex: (index: number) => set({ currentIndex: index }),
  advanceQueue: () => set((state) => ({
    currentIndex: state.currentIndex + 1,
  })),
  goBack: () => set((state) => ({
    currentIndex: Math.max(0, state.currentIndex - 1),
  })),
  advanceCircular: () => {
    let wrapped = false
    set((state) => {
      const next = state.currentIndex + 1
      wrapped = next >= state.queue.length
      return { currentIndex: wrapped ? 0 : next }
    })
    return wrapped
  },
  goBackCircular: () => {
    let wrapped = false
    set((state) => {
      const prev = state.currentIndex - 1
      wrapped = prev < 0
      return { currentIndex: wrapped ? state.queue.length - 1 : prev }
    })
    return wrapped
  },
  updateQueueItem: (index, updates) =>
    set((state) => {
      const newQueue = [...state.queue]
      newQueue[index] = { ...newQueue[index], ...updates }
      return { queue: newQueue }
    }),

  currentArticleId: null,
  setCurrentArticleId: (id) => set({ currentArticleId: id }),

  isLoading: false,
  setIsLoading: (loading) => set({ isLoading: loading }),

  settings: {},
  setSettings: (settings) => set({ settings }),
  updateSetting: (key, value) =>
    set((state) => ({
      settings: { ...state.settings, [key]: value },
    })),

  bookmarkReadIds: new Set<number>(),
  setBookmarkReadIds: (ids: number[]) => set({ bookmarkReadIds: new Set(ids) }),
  toggleBookmarkRead: (id) =>
    set((state) => {
      const next = new Set(state.bookmarkReadIds)
      if (next.has(id)) {
        next.delete(id)
        window.electronAPI?.markArticleUnread(id)
      } else {
        next.add(id)
        window.electronAPI?.markArticleRead(id)
      }
      return { bookmarkReadIds: next }
    }),
}))
