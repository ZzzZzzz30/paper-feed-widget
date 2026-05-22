import initSqlJs, { type SqlJsStatic, type Database as SqlJsDb, type Statement, type SqlValue } from 'sql.js'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'

let sqlJs: SqlJsStatic | null = null
let sqliteDb: SqlJsDb | null = null
let dbWrapper: DatabaseWrapper | null = null

/**
 * SQL.js Database wrapper that mimics better-sqlite3 API
 */
class DatabaseWrapper {
  constructor(private db: SqlJsDb) {}

  exec(sql: string): void {
    this.db.exec(sql)
  }

  pragma(_pragma: string): void {
    // sql.js handles PRAGMA via exec
  }

  prepare(sql: string): StatementWrapper {
    const stmt = this.db.prepare(sql)
    return new StatementWrapper(stmt)
  }

  export(): Uint8Array {
    return this.db.export()
  }

  close(): void {
    this.db.close()
  }
}

class StatementWrapper {
  constructor(private stmt: Statement) {}

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
    this.stmt.bind(params as SqlValue[])
    this.stmt.step()
    const rowsModified = this.stmt.getAsObject()
    this.stmt.free()

    // Run a separate query to get lastInsertRowid
    // sql.js tracks this via db.exec but not easily accessible per-statement
    return {
      changes: 0,
      lastInsertRowid: 0,
    }
  }
}

export async function initDatabase(): Promise<void> {
  sqlJs = await initSqlJs()
  const dbPath = path.join(app.getPath('userData'), 'paperfeed.db')

  let buffer: ArrayBuffer | undefined
  if (fs.existsSync(dbPath)) {
    buffer = fs.readFileSync(dbPath).buffer as ArrayBuffer
  }

  sqliteDb = new sqlJs.Database(buffer ? new Uint8Array(buffer) : undefined)
  dbWrapper = new DatabaseWrapper(sqliteDb)

  // 自动保存
  setInterval(() => saveDatabase(dbPath), 30_000)

  // WAL 模式（sql.js 不完全支持，忽略）
  dbWrapper.exec('PRAGMA foreign_keys = ON')

  // 自动迁移：为旧数据库补加新列
  const migrations = [
    "ALTER TABLE articles ADD COLUMN extra_doi TEXT",
    "ALTER TABLE articles ADD COLUMN author_keywords TEXT",
    "ALTER TABLE articles ADD COLUMN title_cn TEXT",
    "ALTER TABLE articles ADD COLUMN abstract_cn TEXT",
    "ALTER TABLE articles ADD COLUMN graphical_abstract_url TEXT",
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

  // 默认设置
  const defaults: Record<string, string> = {
    year_from: '2015',
    push_frequency_hours: '12',
    push_count: '20',
    llm_provider: 'ollama',
    llm_model: 'qwen2.5:7b',
    theme: 'auto',
    auto_start: 'true',
    push_start_hour: '8',
    push_end_hour: '22',
    elsevier_api_key: '',
    api_key_openai: '',
    api_key_anthropic: '',
    tencent_secret_id: '',
    tencent_secret_key: '',
    deepseek_monthly_budget_usd: '2',
    deepseek_initial_used_usd: '0',
    deepseek_warn_ratio: '0.8',
    deepseek_stop_ratio: '0.9',
    translation_provider: 'tencent',
    allow_translation_fallback: 'false',
    tencent_char_limit: '500',
    aliyun_char_limit: '100',
    tencent_warn_ratio: '0.8',
    tencent_stop_ratio: '0.9',
    aliyun_warn_ratio: '0.8',
    aliyun_stop_ratio: '0.9',
    tencent_initial_used_chars: '0',
    aliyun_initial_used_chars: '0',
  }

  for (const [key, value] of Object.entries(defaults)) {
    dbWrapper.prepare(
      'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
    ).run(key, value)
  }

  // 迁移旧用户：如果 tencent_char_limit 和 aliyun_char_limit 都是 0（旧默认值），更新为新默认值
  try {
    const tc = dbWrapper.prepare("SELECT value FROM settings WHERE key = 'tencent_char_limit'").get() as { value?: string } | undefined
    const ac = dbWrapper.prepare("SELECT value FROM settings WHERE key = 'aliyun_char_limit'").get() as { value?: string } | undefined
    const oldGlobal = dbWrapper.prepare("SELECT value FROM settings WHERE key = 'translation_char_limit'").get() as { value?: string } | undefined
    // 只有旧全局限额存在、或两个新限额都是0，才迁移
    if (oldGlobal?.value && oldGlobal.value !== '0') {
      // 有旧的全局限额设置，但新分服务限额未设置 → 迁移
      if (!tc && !ac) {
        dbWrapper.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('tencent_char_limit', ?)").run(oldGlobal.value)
        dbWrapper.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('aliyun_char_limit', ?)").run(oldGlobal.value)
        console.log('[DB] 已从旧 translation_char_limit 迁移到分服务限额')
      }
    }
    if (tc?.value === '0' && ac?.value === '0') {
      dbWrapper.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('tencent_char_limit', '500')").run()
      dbWrapper.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('aliyun_char_limit', '100')").run()
      dbWrapper.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('allow_translation_fallback', 'false')").run()
      console.log('[DB] 已迁移旧用户翻译限额为安全默认值')
    }
  } catch { /* 迁移失败不影响启动 */ }

  saveDatabase(dbPath)
}

function saveDatabase(dbPath: string): void {
  if (!sqliteDb) return
  try {
    const data = sqliteDb.export()
    const dir = path.dirname(dbPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(dbPath, Buffer.from(data))
  } catch (err) {
    console.error('[DB] 保存失败:', err)
  }
}

export function getDb(): DatabaseWrapper {
  if (!dbWrapper) throw new Error('Database not initialized. Call initDatabase() first.')
  return dbWrapper
}

export function saveNow(): void {
  const dbPath = path.join(app.getPath('userData'), 'paperfeed.db')
  saveDatabase(dbPath)
  console.log('[DB] saveNow →', dbPath)
}
