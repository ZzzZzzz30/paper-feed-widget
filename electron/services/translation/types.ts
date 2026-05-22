export type TranslationProvider = 'tencent' | 'aliyun' | 'ollama'

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
  tencentChars: number
  aliyunChars: number
  ollamaChars: number
  totalChars: number
}
