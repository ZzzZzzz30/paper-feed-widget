import { getConfiguredMinYear } from './publication-policy'
import initSqlJs, { type SqlJsStatic, type Database as SqlJsDb, type Statement, type SqlValue } from 'sql.js'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'

let sqlJs: SqlJsStatic | null = null
let sqliteDb: SqlJsDb | null = null
let dbWrapper: DatabaseWrapper | null = null
let dirty = false
let saveTimer: ReturnType<typeof setTimeout> | null = null

function totalChanges(db: SqlJsDb): number {
  return Number(db.exec('SELECT total_changes()')[0]?.values[0]?.[0] || 0)
}

function markDirty(): void {
  dirty = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveDatabase(path.join(app.getPath('userData'), 'paperfeed.db'))
  }, 750)
  saveTimer.unref()
}

/**
 * SQL.js Database wrapper that mimics better-sqlite3 API
 */
class DatabaseWrapper {
  constructor(private db: SqlJsDb) {}

  exec(sql: string): void {
    const before = totalChanges(this.db)
    const schemaBefore = this.db.exec('PRAGMA schema_version')[0]?.values[0]?.[0]
    try {
      this.db.exec(sql)
    } finally {
      const schemaAfter = this.db.exec('PRAGMA schema_version')[0]?.values[0]?.[0]
      if (totalChanges(this.db) !== before || schemaAfter !== schemaBefore) markDirty()
    }
  }

  pragma(_pragma: string): void {
    // sql.js handles PRAGMA via exec
  }

  prepare(sql: string): StatementWrapper {
    const stmt = this.db.prepare(sql)
    return new StatementWrapper(stmt, this.db)
  }

  export(): Uint8Array {
    return this.db.export()
  }

  close(): void {
    this.db.close()
  }
}

class StatementWrapper {
  constructor(private stmt: Statement, private db: SqlJsDb) {}

  get(...params: unknown[]): Record<string, unknown> | undefined {
    this.stmt.bind(params as SqlValue[])
    if (this.stmt.step()) {
      const row = this.stmt.getAsObject()
      this.stmt.free()
      return row as Record<string, unknown>
    }
    this.stmt.free()
    return undefined
  }

  all(...params: unknown[]): Record<string, unknown>[] {
    this.stmt.bind(params as SqlValue[])
    const rows: Record<string, unknown>[] = []
    while (this.stmt.step()) {
      rows.push(this.stmt.getAsObject() as Record<string, unknown>)
    }
    this.stmt.free()
    return rows
  }

  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const before = totalChanges(this.db)
    try {
      this.stmt.bind(params as SqlValue[])
      this.stmt.step()
      const changes = this.db.getRowsModified()
      const rows = this.db.exec('SELECT last_insert_rowid() AS id')
      const rawId = rows[0]?.values?.[0]?.[0]
      const lastInsertRowid = typeof rawId === 'number' ? rawId : Number(rawId) || 0
      return { changes, lastInsertRowid }
    } finally {
      this.stmt.free()
      if (totalChanges(this.db) !== before) markDirty()
    }
  }
}

export async function initDatabase(): Promise<void> {
  sqlJs = await initSqlJs()
  const dbPath = path.join(app.getPath('userData'), 'paperfeed.db')

  let buffer: Uint8Array | undefined
  if (fs.existsSync(dbPath)) {
    buffer = new Uint8Array(fs.readFileSync(dbPath))
  }

  sqliteDb = new sqlJs.Database(buffer)
  dbWrapper = new DatabaseWrapper(sqliteDb)

  // 自动保存
  setInterval(() => saveDatabase(dbPath), 30_000).unref()

  // WAL 模式（sql.js 不完全支持，忽略）
  dbWrapper.exec('PRAGMA foreign_keys = ON')

  dbWrapper.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doi TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      abstract TEXT,
      authors TEXT,
      journal TEXT NOT NULL,
      issn TEXT,
      publication_date TEXT,
      year INTEGER,
      url TEXT,
      pdf_url TEXT,
      graphical_abstract_url TEXT,
      extra_doi TEXT,
      author_keywords TEXT,
      title_cn TEXT,
      abstract_cn TEXT,
      source_type TEXT DEFAULT 'journal',
      source_key TEXT,
      conference_id TEXT,
      fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      is_processed BOOLEAN DEFAULT 0,
      is_pushed BOOLEAN DEFAULT 0,
      push_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER REFERENCES articles(id) UNIQUE,
      tldr TEXT,
      research_question TEXT,
      method TEXT,
      innovation TEXT,
      findings TEXT,
      topics TEXT,
      limitations TEXT,
      raw_json TEXT,
      model_used TEXT,
      analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER REFERENCES articles(id),
      action TEXT NOT NULL,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT UNIQUE NOT NULL,
      weight REAL DEFAULT 0.0,
      interaction_count INTEGER DEFAULT 0,
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS blacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER REFERENCES articles(id),
      topic TEXT,
      reason TEXT DEFAULT 'user_dislike',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS figures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER REFERENCES articles(id),
      image_path TEXT,
      caption TEXT,
      figure_number INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  // 自动迁移：为旧数据库补加新列
  const migrations = [
    "ALTER TABLE articles ADD COLUMN extra_doi TEXT",
    "ALTER TABLE articles ADD COLUMN author_keywords TEXT",
    "ALTER TABLE articles ADD COLUMN title_cn TEXT",
    "ALTER TABLE articles ADD COLUMN abstract_cn TEXT",
    "ALTER TABLE articles ADD COLUMN graphical_abstract_url TEXT",
    "ALTER TABLE articles ADD COLUMN source_type TEXT DEFAULT 'journal'",
    "ALTER TABLE articles ADD COLUMN source_key TEXT",
    "ALTER TABLE articles ADD COLUMN conference_id TEXT",
  ]
  for (const sql of migrations) {
    try { dbWrapper.exec(sql) } catch { /* 列已存在则跳过 */ }
  }

  // 预缓存状态字段迁移
  const precacheMigrations = [
    "ALTER TABLE articles ADD COLUMN display_status TEXT",
    "ALTER TABLE articles ADD COLUMN priority INTEGER DEFAULT 0",
  ]
  for (const sql of precacheMigrations) {
    try { dbWrapper.exec(sql) } catch { /* skip */ }
  }

  // AI 分析相关表
  dbWrapper.exec(`
    CREATE TABLE IF NOT EXISTS article_ai_summaries (article_id INTEGER PRIMARY KEY, summary_cn TEXT, model TEXT, prompt_version TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS analysis_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, article_id INTEGER NOT NULL, title TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS analysis_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT);
  `)

  // 抓取进度表（分页翻页）
  dbWrapper.exec(`
    CREATE TABLE IF NOT EXISTS journal_fetch_state (
      journal TEXT PRIMARY KEY,
      issn TEXT,
      next_offset INTEGER DEFAULT 0,
      page_size INTEGER DEFAULT 25,
      last_fetch_at TEXT
    );
    CREATE TABLE IF NOT EXISTS conference_fetch_state (
      conference_id TEXT NOT NULL,
      publication_year INTEGER NOT NULL,
      last_success_at TEXT,
      last_error TEXT,
      PRIMARY KEY (conference_id, publication_year)
    );
    CREATE TABLE IF NOT EXISTS cvf_directory_day (
      conference_id TEXT NOT NULL,
      publication_year INTEGER NOT NULL,
      day TEXT NOT NULL,
      last_error TEXT,
      PRIMARY KEY (conference_id, publication_year, day)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS articles_source_key_unique ON articles(source_key) WHERE source_key IS NOT NULL AND source_key != '';
    CREATE INDEX IF NOT EXISTS articles_conference_year_title ON articles(conference_id, year, title);
    CREATE INDEX IF NOT EXISTS articles_extra_doi_lower ON articles(lower(extra_doi));
  `)

  // AI 用量统计表
  dbWrapper.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      feature TEXT,
      article_id INTEGER,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `)

  // 翻译用量表（独立于 AI 用量，按字符记录）
  dbWrapper.exec(`
    CREATE TABLE IF NOT EXISTS translation_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      article_id INTEGER,
      char_count INTEGER DEFAULT 0,
      success INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `)

  // 翻译控制状态表
  dbWrapper.exec(`
    CREATE TABLE IF NOT EXISTS translation_control (
      provider TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active',
      reason TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `)

  // 迁移：article_ai_summaries 加 prompt_version
  try { dbWrapper.exec("ALTER TABLE article_ai_summaries ADD COLUMN prompt_version TEXT DEFAULT 'v1'") } catch {}
  // 清除旧版本缓存
  try { dbWrapper.exec("DELETE FROM article_ai_summaries WHERE prompt_version IS NULL OR prompt_version != 'brief_v2'") } catch {}

  // 已有完整数据的标记为 display_ready
  dbWrapper.exec("UPDATE articles SET display_status='display_ready' WHERE title_cn IS NOT NULL AND title_cn != '' AND abstract IS NOT NULL AND abstract != '' AND display_status IS NULL")
  // 无摘要标记
  dbWrapper.exec("UPDATE articles SET display_status='no_abstract' WHERE (abstract IS NULL OR abstract = '') AND display_status IS NULL")

  // Remove the retired startup preference without touching other settings.
  dbWrapper.prepare("DELETE FROM settings WHERE key='auto_start'").run()
  dbWrapper.prepare("DELETE FROM interactions WHERE action='skip'").run()

  // 默认设置
  const defaults: Record<string, string> = {
    year_from: '2025',
    push_frequency_hours: '12',
    push_count: '20',
    llm_provider: 'ollama',
    llm_model: 'qwen2.5:7b',
    theme: 'auto',
    push_start_hour: '8',
    push_end_hour: '22',
    elsevier_api_key: '',
    api_key_openai: '',
    api_key_anthropic: '',
    deepseek_monthly_budget_usd: '2',
    deepseek_initial_used_usd: '0',
    deepseek_warn_ratio: '0.8',
    deepseek_stop_ratio: '0.9',
    translation_provider: 'aliyun',
    allow_translation_fallback: 'false',
    aliyun_char_limit: '100',
    aliyun_warn_ratio: '0.8',
    aliyun_stop_ratio: '0.9',
    aliyun_initial_used_chars: '0',
  }

  for (const [key, value] of Object.entries(defaults)) {
    dbWrapper.prepare(
      'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
    ).run(key, value)
  }

  const journalSeedKey = 'journal_defaults_seed_v1'
  const journalSeed = dbWrapper.prepare('SELECT value FROM settings WHERE key=?').get(journalSeedKey)
  if (!journalSeed) {
    let bundledJournals: Array<{ name: string; issn: string; rssUrl: string }> = []
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'journals.json'), 'utf-8'))
      if (Array.isArray(parsed)) {
        bundledJournals = parsed.filter((item): item is { name: string; issn: string; rssUrl: string } =>
          !!item && typeof item.name === 'string' && typeof item.issn === 'string' && typeof item.rssUrl === 'string')
      }
    } catch (error) {
      console.error('[DB] Bundled journal defaults could not be loaded', error)
    }

    const saved = dbWrapper.prepare("SELECT value FROM settings WHERE key='journals'").get() as { value?: string } | undefined
    let journals: Array<{ name?: string; issn?: string; rssUrl?: string }> = []
    try {
      const parsed: unknown = JSON.parse(saved?.value || '[]')
      if (Array.isArray(parsed)) journals = parsed.filter(item => !!item && typeof item === 'object')
    } catch {}

    const seenIssns = new Set(journals.map(item => item.issn?.toUpperCase()).filter(Boolean))
    const seenNames = new Set(journals.map(item => item.name?.trim().toLowerCase()).filter(Boolean))
    for (const journal of bundledJournals) {
      if (seenIssns.has(journal.issn.toUpperCase()) || seenNames.has(journal.name.toLowerCase())) continue
      journals.push(journal)
      seenIssns.add(journal.issn.toUpperCase())
      seenNames.add(journal.name.toLowerCase())
    }
    dbWrapper.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('journals',?)").run(JSON.stringify(journals))
    dbWrapper.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(journalSeedKey, 'true')
  }

  const yearSetting = dbWrapper.prepare("SELECT value FROM settings WHERE key='year_from'").get() as { value?: string } | undefined
  const yearFrom = getConfiguredMinYear(yearSetting?.value)
  if (yearSetting?.value !== String(yearFrom)) {
    dbWrapper.prepare("UPDATE settings SET value=? WHERE key='year_from'").run(String(yearFrom))
  }

  dbWrapper.prepare("UPDATE settings SET value='aliyun' WHERE key='translation_provider' AND value='tencent'").run()

  // Give previously skipped Elsevier records one pass through the fixed abstract lookup.
  const abstractRetryKey = 'elsevier_abstract_retry_v1'
  if (!dbWrapper.prepare('SELECT 1 FROM settings WHERE key=?').get(abstractRetryKey)) {
    dbWrapper.prepare(`
      UPDATE articles SET display_status='metadata'
      WHERE source_type='journal' AND year>=? AND display_status='no_abstract'
        AND lower(extra_doi) LIKE '10.1016/%'
        AND length(trim(coalesce(abstract,''))) < 50
    `).run(yearFrom)
    dbWrapper.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(abstractRetryKey, 'true')
  }

  saveDatabase(dbPath)
}

function saveDatabase(dbPath: string, throwOnError = false): void {
  if (!sqliteDb || !dirty) return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    const data = sqliteDb.export()
    const dir = path.dirname(dbPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const tempPath = `${dbPath}.tmp`
    fs.writeFileSync(tempPath, Buffer.from(data))
    fs.renameSync(tempPath, dbPath)
    dirty = false
  } catch (err) {
    console.error('[DB] 保存失败:', err)
    if (throwOnError) throw err
  }
}

export function getDb(): DatabaseWrapper {
  if (!dbWrapper) throw new Error('Database not initialized. Call initDatabase() first.')
  return dbWrapper
}

export function saveNow(): void {
  const dbPath = path.join(app.getPath('userData'), 'paperfeed.db')
  saveDatabase(dbPath, true)
}
