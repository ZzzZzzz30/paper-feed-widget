import Parser from 'rss-parser'

const parser = new Parser({
  customFields: {
    item: [
      ['description', 'description'],
      ['dc:creator', 'dcCreator'],
    ],
  },
})

interface RSSItem {
  title: string
  link: string
  pubDate: string
  content: string
  description: string
  creator: string
}

export async function parseRSSFeed(url: string): Promise<RSSItem[]> {
  try {
    const feed = await parser.parseURL(url)
    return (feed.items || []).map(item => {
      const raw = item as unknown as Record<string, string>
      return {
        title: raw.title || '',
        link: raw.link || '',
        pubDate: raw.pubDate || raw.pubdate || '',
        content: raw.content || raw.description || '',
        description: raw.description || raw.content || '',
        creator: raw.creator || raw.dcCreator || '',
      }
    })
  } catch (err) {
    console.error(`[RSS] 解析失败 ${url}:`, err)
    return []
  }
}
