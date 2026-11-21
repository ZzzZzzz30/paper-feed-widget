export type TranslationProvider = 'aliyun' | 'ollama'

export class TranslationUnavailableError extends Error {
  override name = 'TranslationUnavailableError'
}

export class TranslationFailedError extends Error {
  override name = 'TranslationFailedError'
}

export interface TranslateInput {
  articleId: number
  title: string
  abstract: string
}

export interface TranslateResult {
  title_cn: string
  abstract_cn: string
  provider: TranslationProvider
}

export interface TranslationUsage {
  aliyunChars: number
  ollamaChars: number
  totalChars: number
}
