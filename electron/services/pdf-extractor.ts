/**
 * PDF 图表提取服务
 *
 * 当前实现：优先通过 ScienceDirect API 获取 Graphical Abstract，
 * 降级为返回 PDF URL 供前端在线渲染。
 */

import { getDb } from './db'

interface FigureInfo {
  imagePath: string  // URL 或本地路径
  caption: string
  figureNumber: number
}

/**
 * 获取文章的图表信息
 * 优先返回 Graphical Abstract，其次返回 PDF 链接
 */
export async function getArticleFigures(articleId: number): Promise<{
  graphicalAbstract?: string
  figures: FigureInfo[]
  pdfUrl?: string
}> {
  const db = getDb()

  const article = db.prepare(
    'SELECT graphical_abstract_url, pdf_url FROM articles WHERE id = ?'
  ).get(articleId) as {
    graphical_abstract_url: string
    pdf_url: string
  } | undefined

  if (!article) return { figures: [] }

  const result: {
    graphicalAbstract?: string
    figures: FigureInfo[]
    pdfUrl?: string
  } = { figures: [] }

  // 优先：Graphical Abstract
  if (article.graphical_abstract_url) {
    result.graphicalAbstract = article.graphical_abstract_url
  }

  // 降级：PDF URL
  if (article.pdf_url) {
    result.pdfUrl = article.pdf_url
  }

  return result
}
