const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const root = process.env.PAPERFEED_TEST_ROOT || path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(root, 'package.json'))
const ts = localRequire('typescript')

function loadSource(relative, mocks = {}, globals = {}) {
  if (relative === 'electron/services/conference-fetcher.ts' && !mocks['./architecture-proceedings']) {
    mocks['./architecture-proceedings'] = loadSource('electron/services/architecture-proceedings.ts', {
      './db': mocks['./db'], './article-matching': mocks['./article-matching'],
    })
  }
  const filename = path.join(root, relative)
  const req = createRequire(filename)
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, {
    exports: module.exports, module, __filename: filename, __dirname: path.dirname(filename),
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : req(name),
    Buffer, process, URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    console: { log() {}, error() {}, warn() {} }, ...globals,
  }, { filename })
  return module.exports
}

async function database(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paperfeed-requested-'))
  const timers = new Map()
  const intervals = []
  let writes = 0
  let failRename = false
  const disk = new Proxy(fs, { get(target, property) {
    if (property === 'writeFileSync') return (...args) => { writes++; return fs.writeFileSync(...args) }
    if (property === 'renameSync') return (...args) => {
      if (failRename) throw new Error('simulated disk failure')
      return fs.renameSync(...args)
    }
    return target[property]
  } })
  const api = loadSource('electron/services/db.ts', {
    electron: { app: { getPath: () => directory, getAppPath: () => root } }, fs: disk,
    './publication-policy': loadSource('electron/services/publication-policy.ts'),
  }, {
    setTimeout: (callback, delay) => { const handle = { unref() {} }; timers.set(handle, { callback, delay }); return handle },
    clearTimeout: handle => timers.delete(handle),
    setInterval: callback => { intervals.push(callback); return { unref() {} } },
  })
  await api.initDatabase()
  t.after(() => { api.getDb().close(); fs.rmSync(directory, { recursive: true, force: true }) })
  return {
    api, db: api.getDb(), directory, timers, intervals,
    writes: () => writes,
    failRename: value => { failRename = value },
    flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach(timer => timer.callback()) },
  }
}

function secretApi(harness, available = true) {
  // The integration smoke test exercises the real Windows safeStorage provider.
  const storage = {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from('test-cipher:' + Buffer.from(value).toString('base64')),
    decryptString: buffer => {
      if (!buffer.toString().startsWith('test-cipher:')) throw new Error('invalid cipher')
      return Buffer.from(buffer.toString().slice(12), 'base64').toString()
    },
  }
  return loadSource('electron/services/secure-settings.ts', { electron: { safeStorage: storage }, './db': harness.api })
}

test('database skips clean checkpoints, combines changes, preserves data, and retries failed saves', async t => {
  const h = await database(t)
  const initial = h.writes()
  h.api.saveNow()
  h.intervals.forEach(callback => callback())
  h.db.prepare('SELECT * FROM settings').all()
  h.db.exec('SELECT * FROM settings')
  h.db.prepare("UPDATE settings SET value='ignored' WHERE key='nonexistent'").run()
  h.db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES ('theme','ignored')").run()
  assert.equal(h.timers.size, 0)
  assert.equal(h.writes(), initial)

  const secrets = secretApi(h)
  for (let index = 0; index < 40; index++) secrets.writeSettingValue('font_size', String(index + 13))
  assert.equal(h.writes(), initial)
  assert.equal(h.timers.size, 1)
  h.flush()
  assert.equal(h.writes(), initial + 1)
  assert.equal(h.db.prepare("SELECT value FROM settings WHERE key='font_size'").get().value, '52')
  assert.equal(secrets.writeSettingValue('font_size', '52'), false)
  assert.equal(h.timers.size, 0)

  secrets.writeSettingValue('theme', 'paper')
  h.failRename(true)
  assert.throws(() => h.api.saveNow(), /disk failure/)
  h.failRename(false)
  h.intervals.forEach(callback => callback())
  const saved = h.writes()
  h.api.saveNow()
  assert.equal(h.writes(), saved)
  const SQL = await localRequire('sql.js')()
  const reopened = new SQL.Database(new Uint8Array(fs.readFileSync(path.join(h.directory, 'paperfeed.db'))))
  assert.equal(reopened.exec("SELECT value FROM settings WHERE key='theme'")[0].values[0][0], 'paper')
  reopened.close()
})

test('public database starts with empty journal subscriptions and accepts user subscriptions', async t => {
  const h = await database(t)
  const rows = h.db.prepare("SELECT value FROM settings WHERE key='journals'").get()
  const journals = JSON.parse(rows.value)
  assert.deepEqual(journals, [])

  const custom = { name: 'Saved Custom Journal', issn: '1234-5678', rssUrl: '' }
  h.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('journals',?)")
    .run(JSON.stringify([...journals, custom]))
  h.db.prepare("DELETE FROM settings WHERE key='journal_defaults_seed_v1'").run()
  h.api.initDatabase = h.api.initDatabase.bind(h.api)
  assert.equal(h.db.prepare("SELECT value FROM settings WHERE key='journals'").get().value.includes('Saved Custom Journal'), true)
})

test('all legacy secrets migrate, are masked from renderer, and can be replaced or deleted', async t => {
  const h = await database(t)
  const secrets = secretApi(h)
  for (const key of secrets.SECRET_SETTING_KEYS) h.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(key, 'fixture-' + key)
  secrets.migrateSecretSettings()
  for (const key of secrets.SECRET_SETTING_KEYS) {
    assert.match(h.db.prepare('SELECT value FROM settings WHERE key=?').get(key).value, /^paperfeed:encrypted:v1:/)
    assert.equal(secrets.readSecretSetting(key), 'fixture-' + key)
    assert.equal(secrets.getSettingsForRenderer()[key], '')
    assert.equal(secrets.getSettingsForRenderer()[key + '_configured'], 'true')
  }
  const before = h.writes()
  secrets.migrateSecretSettings()
  assert.equal(h.writes(), before)
  assert.equal(secrets.writeSettingValue('deepseek_api_key', 'fixture-deepseek_api_key'), false)
  assert.equal(secrets.writeSettingValue('deepseek_api_key', 'new-fixture'), true)
  assert.equal(secrets.readSecretSetting('deepseek_api_key'), 'new-fixture')
  secrets.writeSettingValue('deepseek_api_key', '')
  assert.equal(secrets.readSecretSetting('deepseek_api_key'), '')
  h.api.saveNow()
  const serialized = fs.readFileSync(path.join(h.directory, 'paperfeed.db'))
  assert.equal(serialized.includes(Buffer.from('fixture-deepseek_api_key')), false)
})

test('unavailable encryption never saves new plaintext or deletes legacy keys', async t => {
  const h = await database(t)
  const secrets = secretApi(h, false)
  assert.throws(() => secrets.writeSettingValue('deepseek_api_key', 'fixture-new-key'), /系统安全存储/)
  assert.equal(h.db.prepare("SELECT value FROM settings WHERE key='deepseek_api_key'").get(), undefined)
  h.db.prepare("INSERT INTO settings(key,value) VALUES ('deepseek_api_key','fixture-existing-key')").run()
  assert.throws(() => secrets.migrateSecretSettings(), /无法安全迁移/)
  assert.equal(secrets.readSecretSetting('deepseek_api_key'), '')
  assert.equal(secrets.getSettingsForRenderer().deepseek_api_key, '')
  assert.equal(h.db.prepare("SELECT value FROM settings WHERE key='deepseek_api_key'").get().value, 'fixture-existing-key')
})

const matching = loadSource('electron/services/article-matching.ts')
const journal = { name: 'Fixture Journal', issn: '1234-5678', rssUrl: 'https://fixture.invalid/rss' }
const title = 'Urban Risk & Resilience'
const work = (DOI = '10.1234/fixture.1', overrides = {}) => ({
  DOI, title: [title], type: 'journal-article', ISSN: [journal.issn], abstract: 'Correct fixture abstract',
  published: { 'date-parts': [[2026, 10, 1]] }, ...overrides,
})

test('metadata matching rejects wrong title/journal/type/year/DOI and ambiguous results', () => {
  const good = work()
  const wrong = work('10.1234/wrong', { title: ['A similar but different paper'] })
  assert.equal(matching.findExactJournalArticle(title, [wrong, good], { issn: journal.issn, year: 2026 }), good)
  assert.equal(matching.findExactJournalArticle(title, [work('10.1234/other', { ISSN: ['0000-0000'] })], { issn: journal.issn }), undefined)
  assert.equal(matching.findExactJournalArticle(title, [work('10.1234/other', { type: 'proceedings-article' })]), undefined)
  assert.equal(matching.findExactJournalArticle(title, [work('10.1234/other', { type: 'proceedings-article' })], { type: 'proceedings-article' }).DOI, '10.1234/other')
  assert.equal(matching.findExactJournalArticle(title, [good], { year: 2000 }), undefined)
  assert.equal(matching.findExactJournalArticle(title, [good], { doi: '10.1234/another' }), undefined)
  assert.equal(matching.findExactJournalArticle(title, [good, work('10.1234/another')]), undefined)
  assert.equal(matching.normalizeArticleTitle('  Urban <i>Risk</i> &amp; RESILIENCE  '), matching.normalizeArticleTitle(title))
  assert.notEqual(matching.normalizeArticleTitle('Effects of A+B'), matching.normalizeArticleTitle('Effects of A-B'))
  assert.equal(matching.normalizeDoi('https://doi.org/10.1234/FIXTURE.1'), '10.1234/fixture.1')
})

test('publication policy accepts configurable years and rejects invalid values', () => {
  const policy = loadSource('electron/services/publication-policy.ts')
  assert.equal(policy.getConfiguredMinYear('2015'), 2015)
  assert.equal(policy.getConfiguredMinYear('2024abc'), 2025)
  assert.equal(policy.getConfiguredMinYear('0'), 2025)
  assert.equal(policy.getConfiguredMinYear(''), 2025)
  assert.equal(policy.isEligiblePublicationYear(2024, 2026), false)
  assert.equal(policy.getConfiguredMinYear('2026'), 2026)
  assert.equal(policy.isEligiblePublicationYear(2024), true)
  assert.equal(policy.isEligiblePublicationYear(2025), true)
  assert.equal(policy.isEligiblePublicationYear('2025'), false)
})

test('conference records without DOI use stable keys, merge duplicates, and reopen after an abstract arrives', async t => {
  const h = await database(t)
  const service = loadSource('electron/services/conference-fetcher.ts', {
    './db': h.api,
    './article-matching': matching,
    './publication-policy': loadSource('electron/services/publication-policy.ts'),
    'node-cron': { schedule() {} },
  }, { fetch: async () => { throw new Error('not used in this test') } })
  const source = { id: 'cvpr', name: 'CVPR' }
  const paper = {
    sourceId: 'cvpr:2026:paper-1', doi: '', title: 'A Conference Paper', abstract: '',
    authors: ['Ada Example'], publicationDate: '2026', url: 'https://papers.example/1', pdfUrl: 'https://papers.example/1.pdf',
  }
  assert.equal(service.upsertConferencePaper(source, 2026, paper), true)
  const inserted = h.db.prepare('SELECT * FROM articles').get()
  assert.match(inserted.doi, /^paperfeed:cvpr:/)
  assert.equal(inserted.source_type, 'conference')
  assert.equal(inserted.conference_id, 'cvpr')
  assert.equal(inserted.url, paper.url)
  h.db.prepare("UPDATE articles SET display_status='no_abstract' WHERE id=?").run(inserted.id)

  const enriched = { ...paper, doi: '10.5555/cvpr.1', abstract: 'A'.repeat(80) }
  assert.equal(service.upsertConferencePaper(source, 2026, enriched), false)
  const row = h.db.prepare('SELECT * FROM articles').get()
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM articles').get().count, 1)
  assert.equal(row.extra_doi, '10.5555/cvpr.1')
  assert.equal(row.abstract, 'A'.repeat(80))
  assert.equal(row.display_status, null)
})

test('Crossref abstract enrichment requeues an unavailable conference paper for translation', async t => {
  const h = await database(t)
  const paper = {
    sourceId: 'iclr:2026:forum-1', doi: '', title: 'A Conference Paper', abstract: '',
    authors: ['Ada Example'], publicationDate: '2026', url: 'https://papers.example/1', pdfUrl: '',
  }
  const conference = loadSource('electron/services/conference-fetcher.ts', {
    './db': h.api, './article-matching': matching,
    './publication-policy': loadSource('electron/services/publication-policy.ts'),
    'node-cron': { schedule() {} },
  })
  conference.upsertConferencePaper({ id: 'iclr', name: 'ICLR' }, 2026, paper)
  const row = h.db.prepare('SELECT id FROM articles').get()
  h.db.prepare("UPDATE articles SET display_status='no_abstract' WHERE id=?").run(row.id)

  const abstract = 'A proceedings abstract long enough to be translated. '.repeat(3)
  const article = { DOI: '10.5555/iclr.1', title: [paper.title], type: 'proceedings-article', abstract, published: { 'date-parts': [[2026, 1, 1]] } }
  const fetcher = loadSource('electron/services/abstract-fetcher.ts', {
    './db': h.api,
    './secure-settings': { readSecretSetting: () => '' },
    './article-matching': matching,
  }, { fetch: async () => ({ ok: true, json: async () => ({ message: { items: [article] } }) }) })
  assert.equal(await fetcher.fetchAbstractsForArticles([row.id]), 1)
  const updated = h.db.prepare('SELECT abstract,extra_doi,display_status FROM articles WHERE id=?').get(row.id)
  assert.equal(updated.abstract, abstract)
  assert.equal(updated.extra_doi, '10.5555/iclr.1')
  assert.equal(updated.display_status, null)
})

test('CVF directory parser splits papers and retains their official page and PDF links', () => {
  const service = loadSource('electron/services/conference-fetcher.ts', {
    './db': {}, './article-matching': matching,
    './publication-policy': loadSource('electron/services/publication-policy.ts'),
    'node-cron': { schedule() {} },
  })
  const html = '<dt class="ptitle"><a href="/content/CVPR2026/html/paper.html">Paper &amp; Method</a></dt>'
    + '<dd>Ada Example, Bob Sample</dd><dd><a href="/content/CVPR2026/papers/paper.pdf">pdf</a></dd>'
    + '<div id="abstract">A useful abstract.</div><dt class="ptitle">'
  const [paper] = service.parseCvfPage(html, 'cvpr', 2026)
  assert.equal(paper.title, 'Paper & Method')
  assert.equal(paper.abstract, 'A useful abstract.')
  assert.match(paper.url, /paper\.html$/)
  assert.match(paper.pdfUrl, /paper\.pdf$/)
  assert.deepEqual(Array.from(paper.authors), ['Ada Example', 'Bob Sample'])
})

test('NeurIPS detail parser extracts abstract, authors, DOI and PDF and merges them with the index record', () => {
  const service = loadSource('electron/services/conference-fetcher.ts', {
    './db': {}, './article-matching': matching,
    './publication-policy': loadSource('electron/services/publication-policy.ts'),
    'node-cron': { schedule() {} },
  })
  const indexPaper = {
    sourceId: 'neurips:2026:https://proceedings.example/abstract', doi: '', title: 'Learning Example', abstract: '',
    authors: ['Ada Example'], publicationDate: '2026', url: 'https://proceedings.example/abstract', pdfUrl: '',
  }
  const detail = service.parseNeuripsDetail(
    '<h4>Abstract</h4><p>NeurIPS abstract text.</p><h4>Authors</h4><p>Ada Example</p>'
      + '<meta name="citation_doi" content="10.5555/neurips.1"><a href="paper.pdf">Paper</a>',
    indexPaper,
  )
  assert.equal(detail.abstract, 'NeurIPS abstract text.')
  assert.equal(detail.doi, '10.5555/neurips.1')
  assert.match(detail.pdfUrl, /paper\.pdf$/)
  const [merged] = service.mergePaperSources([indexPaper, detail])
  assert.equal(merged.abstract, detail.abstract)
  assert.equal(merged.doi, detail.doi)
  assert.match(merged.pdfUrl, /paper\.pdf$/)
})

test('CVF detail pages supply citation authors, date, PDF, and their own abstract', () => {
  const service = loadSource('electron/services/conference-fetcher.ts', {
    './db': {}, './article-matching': matching,
    './publication-policy': loadSource('electron/services/publication-policy.ts'),
    'node-cron': { schedule() {} },
  })
  const base = {
    sourceId: 'cvpr:2025:https://openaccess.thecvf.com/paper.html', doi: '', title: 'Directory title',
    abstract: '', authors: ['Ada Example'], publicationDate: '2025',
    url: 'https://openaccess.thecvf.com/paper.html', pdfUrl: '',
  }
  const detail = service.parseCvfDetail(
    '<meta content="Paper title" name="citation_title">'
      + '<meta name="citation_author" content="Example, Ada">'
      + '<meta name="citation_publication_date" content="2025">'
      + '<meta name="citation_pdf_url" content="/content/paper.pdf">'
      + '<div id="authors"><b>Ada Example</b></div>'
      + '<div id="abstract">A sufficiently long abstract from the official paper page.</div>',
    base,
  )
  assert.equal(detail.title, 'Paper title')
  assert.deepEqual(Array.from(detail.authors), ['Ada Example'])
  assert.equal(detail.abstract, 'A sufficiently long abstract from the official paper page.')
  assert.match(detail.pdfUrl, /content\/paper\.pdf$/)
})

test('NeurIPS selects the Main Conference index, filters out tracks, and retries transient HTTP errors', async () => {
  let calls = 0
  const root = '<a href="/paper_files/paper/2025/vol38-main-conference">NeurIPS 38 Main Conference</a>'
    + '<a href="/paper_files/paper/2025/vol38-creative-ai-track">Creative AI Track</a>'
  const index = '<a title="paper title" href="/paper_files/paper/2025/hash/abc-Abstract-Conference.html">Main paper</a>'
    + '<span class="paper-authors">Ada Example, Bob Sample</span>'
    + '<a href="/paper_files/paper/2025/hash/def-Abstract-Creative_AI_Track.html">Track paper</a>'
  const service = loadSource('electron/services/conference-fetcher.ts', {
    './db': {}, './article-matching': matching,
    './publication-policy': loadSource('electron/services/publication-policy.ts'),
    'node-cron': { schedule() {} },
  }, {
    AbortSignal,
    fetch: async input => {
      calls++
      if (calls === 1) return { status: 503, ok: false, text: async () => '' }
      return { status: 200, ok: true, text: async () => String(input).endsWith('main-conference') ? index : root }
    },
  })
  const [paper] = await service.fetchNeuripsIndex(2025)
  assert.equal(calls, 3)
  assert.equal(paper.title, 'Main paper')
  assert.deepEqual(Array.from(paper.authors), ['Ada Example', 'Bob Sample'])
  assert.match(paper.url, /Abstract-Conference\.html$/)
})

test('ECVA parser reads only the requested ECCV edition and extracts detail DOI and abstract', () => {
  const service = loadSource('electron/services/conference-fetcher.ts', {
    './db': {}, './article-matching': matching,
    './publication-policy': loadSource('electron/services/publication-policy.ts'),
    'node-cron': { schedule() {} },
  })
  const html = '<button class="accordion">ECCV 2026 Papers</button><div class="accordion-content">'
    + '<dt class="ptitle"><a href=papers/eccv_2026/papers_ECCV/html/1_paper.php>New ECCV Paper</a></dt>'
    + '<dd>Ada Example, Bob Sample</dd><dd><a href="papers/eccv_2026/papers_ECCV/papers/00001.pdf">pdf</a></dd>'
    + '<button class="accordion">ECCV 2024 Papers</button><div class="accordion-content">'
    + '<dt class="ptitle"><a href="papers/eccv_2024/paper.php">Old paper</a></dt><dd>Old Author</dd>'
    + '</div>'
  const [paper] = service.parseEcvaIndex(html, 'eccv', 2026)
  assert.equal(paper.title, 'New ECCV Paper')
  assert.deepEqual(Array.from(paper.authors), ['Ada Example', 'Bob Sample'])
  assert.match(paper.pdfUrl, /00001\.pdf$/)
  assert.equal(service.parseEcvaIndex(html, 'eccv', 2025).length, 0)
  const detail = service.parseEcvaDetail(
    '<div id="papertitle">New ECCV Paper</div><div id="authors">Ada Example, Bob Sample;</div>'
      + '<div id="abstract">ECCV abstract content with enough words to verify parsing.</div>'
      + '<a href="https://link.springer.com/chapter/10.1007/978-1">DOI</a>',
    paper,
  )
  assert.equal(detail.abstract, 'ECCV abstract content with enough words to verify parsing.')
  assert.equal(detail.doi, '10.1007/978-1')
})

test('Crossref fallback excludes proceedings volumes and editorial front matter', () => {
  const service = loadSource('electron/services/conference-fetcher.ts', {
    './db': {}, './article-matching': matching,
    './publication-policy': loadSource('electron/services/publication-policy.ts'),
    'node-cron': { schedule() {} },
  })
  assert.equal(service.isNonResearchProceedingsTitle('eCAADe 2025 Confluence - Volume 2'), true)
  assert.equal(service.isNonResearchProceedingsTitle('INTRODUCTION (Conference Introduction)'), true)
  assert.equal(service.isNonResearchProceedingsTitle('Recipe for AI Integration in Architecture'), false)
})

function fetcher(h, rss, page, search) {
  const source = loadSource('electron/services/fetcher.ts', {
    './db': h.api, './rss-parser': { parseRSSFeed: async () => rss }, './article-matching': matching,
    './publication-policy': loadSource('electron/services/publication-policy.ts'),
  }, {
    fetch: async input => {
      const url = new URL(input)
      assert.match(url.searchParams.get('filter'), /issn:1234-5678/)
      return { ok: true, json: async () => ({ message: { items: url.searchParams.has('query.title') ? search : page } }) }
    },
    setTimeout: (callback, delay) => delay === 100 ? (queueMicrotask(callback), { unref() {} }) : setTimeout(callback, delay),
  })
  h.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('journals',?)").run(JSON.stringify([journal]))
  return source
}
const rssItem = { title: 'Urban Risk &amp; Resilience', link: 'https://www.sciencedirect.com/science/article/pii/S0123456789012345', description: '<p>Publication date: October 2026</p>' }
async function settle() { for (let index = 0; index < 12; index++) await new Promise(resolve => setImmediate(resolve)) }

test('RSS first plus Crossref stays one record and keeps bookmarks on repeated fetch', async t => {
  const h = await database(t)
  const api = fetcher(h, [rssItem], [work()], [work('10.1234/wrong', { title: ['Not the requested paper'] }), work()])
  assert.equal(await api.fetchAllJournals(true), 1)
  await settle()
  const article = h.db.prepare('SELECT * FROM articles').get()
  assert.equal(article.extra_doi.toLowerCase(), '10.1234/fixture.1')
  assert.equal(article.abstract, 'Correct fixture abstract')
  h.db.prepare("INSERT INTO interactions(article_id,action) VALUES (?,'bookmark')").run(article.id)
  assert.equal(await api.fetchAllJournals(true), 0)
  await settle()
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM articles').get().count, 1)
  assert.equal(h.db.prepare("SELECT article_id FROM interactions WHERE action='bookmark'").get().article_id, article.id)
})

test('Crossref first plus RSS stays one record; resolved RSS DOI persists without a page match', async t => {
  const h = await database(t)
  const initial = fetcher(h, [], [work()], [])
  assert.equal(await initial.fetchAllJournals(true), 1)
  const rss = fetcher(h, [rssItem], [], [work()])
  assert.equal(await rss.fetchAllJournals(true), 0)
  await settle()
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM articles').get().count, 1)
  h.db.prepare('DELETE FROM articles').run()
  assert.equal(await rss.fetchAllJournals(true), 1)
  await settle()
  assert.equal(h.db.prepare('SELECT extra_doi FROM articles').get().extra_doi, '10.1234/fixture.1')
})

test('different DOIs with the same title remain distinct; ambiguous RSS does not create another', async t => {
  const h = await database(t)
  const api = fetcher(h, [], [work(), work('10.1234/fixture.2')], [])
  assert.equal(await api.fetchAllJournals(true), 2)
  const rss = fetcher(h, [rssItem], [], [work(), work('10.1234/fixture.2')])
  assert.equal(await rss.fetchAllJournals(true), 0)
  await settle()
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM articles').get().count, 2)
})

test('wrong search results cannot supply RSS DOI or abstract', async t => {
  const h = await database(t)
  const wrong = work('10.1234/wrong', { title: ['Unrelated paper'], abstract: 'Wrong abstract' })
  const api = fetcher(h, [rssItem], [], [wrong])
  assert.equal(await api.fetchAllJournals(true), 1)
  await settle()
  const article = h.db.prepare('SELECT * FROM articles').get()
  assert.equal(article.extra_doi || '', '')
  assert.equal(article.abstract || '', '')
  const enrich = loadSource('electron/services/abstract-fetcher.ts', {
    './db': h.api, './secure-settings': secretApi(h), './article-matching': matching,
  }, { fetch: async () => ({ ok: true, json: async () => ({ message: { items: [wrong] } }) }) })
  assert.equal(await enrich.fetchAbstractsForArticles([article.id]), 0)
  assert.equal(h.db.prepare('SELECT abstract FROM articles WHERE id=?').get(article.id).abstract || '', '')
})


test('public push rotates sources without keyword priority and skips ineligible articles', async t => {
  const { db } = await database(t)
  const insert = (id, journal, title, year = 2025, status = 'display_ready') => {
    db.prepare(`INSERT INTO articles (id, doi, title, abstract, title_cn, abstract_cn, journal, year, display_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, `test:${id}`, title, 'A complete abstract for this article. '.repeat(3), '标题', '摘要', journal, year, status)
  }
  insert(1, 'A', 'Ordinary construction research')
  insert(2, 'A', 'LLM agent BIM IFC Revit')
  insert(3, 'B', 'Ordinary engineering research')
  insert(4, 'B', 'LLMs agentic IfcOpenShell')
  insert(5, 'C', 'Bookmarked article')
  insert(6, 'C', 'Dismissed article')
  insert(7, 'C', 'Older article', 2024)
  insert(8, 'C', 'Untranslated article', 2025, 'pending')
  db.prepare("INSERT INTO interactions (article_id, action) VALUES (5, 'bookmark'), (6, 'dislike')").run()
  const push = loadSource('electron/services/push-manager.ts', {
    './db': { getDb: () => db },
    './publication-policy': loadSource('electron/services/publication-policy.ts'),
    './push-keywords': loadSource('electron/services/push-keywords.ts'),
  })
  assert.deepEqual(Array.from(push.selectPushItems(20), item => item.articleId), [1, 3, 2, 4])
  assert.deepEqual(Array.from(push.selectPushItems(20, [1]), item => item.articleId), [3, 2, 4])
  assert.ok(push.selectPushItems(20).every(item => item.score === 0))
  db.prepare("UPDATE settings SET value='2024' WHERE key='year_from'").run()
  assert.ok(push.selectPushItems(20).some(item => item.articleId === 7))
  db.prepare("UPDATE settings SET value='2026' WHERE key='year_from'").run()
  assert.equal(push.selectPushItems(20).length, 0)
})


test('public keywords start empty and honor only the user supplied list', () => {
  const keywords = loadSource('electron/services/push-keywords.ts')
  assert.equal(keywords.readPushKeywords().length, 0)
  assert.equal(keywords.createKeywordScorer(keywords.readPushKeywords())('LLM BIM IFC agent', ''), 0)
  const score = keywords.createKeywordScorer(keywords.readPushKeywords('["digital twin","agent"]'))
  assert.equal(score('Digital-twin with MultiAgent', ''), 2)
  assert.equal(score('LLM BIM IFC', ''), 0)
  assert.equal(keywords.readPushKeywords('[]').length, 0)
})

test('public profile starts empty and preserves a chosen older year after restart', async t => {
  const h = await database(t)
  assert.equal(h.db.prepare('SELECT count(*) AS count FROM articles').get().count, 0)
  assert.equal(h.db.prepare("SELECT value FROM settings WHERE key='journals'").get().value, '[]')
  const conference = loadSource('electron/services/conference-fetcher.ts', {
    './db': h.api, './article-matching': matching,
    './publication-policy': loadSource('electron/services/publication-policy.ts'),
    'node-cron': { schedule() {} },
  })
  assert.ok(conference.getConferenceOptions().every(source => source.enabled === false))
  assert.equal(h.db.prepare("SELECT count(*) AS count FROM settings WHERE (key LIKE '%api_key%' OR key LIKE '%access_key%') AND value != ''").get().count, 0)
  h.db.prepare("UPDATE settings SET value='2018' WHERE key='year_from'").run()
  h.api.saveNow()
  h.db.close()
  await h.api.initDatabase()
  assert.equal(h.api.getDb().prepare("SELECT value FROM settings WHERE key='year_from'").get().value, '2018')
})


test('journal collection accepts pre-2025 articles when the minimum year allows them', async t => {
  const h = await database(t)
  const paper = work('10.1234/older', { published: { 'date-parts': [[2024, 1, 1]] }, 'published-online': { 'date-parts': [[2024, 1, 1]] }, 'published-print': { 'date-parts': [[2024, 1, 1]] } })
  const api = fetcher(h, [], [paper], [])
  assert.equal(await api.fetchAllJournals(true), 0)
  h.db.prepare("UPDATE settings SET value='2024' WHERE key='year_from'").run()
  assert.equal(await api.fetchAllJournals(true), 1)
  assert.equal(h.db.prepare('SELECT year FROM articles').get().year, 2024)
})

test('conference collection visits years down to the saved minimum and filters older records', async t => {
  const h = await database(t)
  h.db.prepare("UPDATE settings SET value='2024' WHERE key='year_from'").run()
  h.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('conferences', ?)").run('[{"id":"caadria","enabled":true}]')
  const visited = []
  const conference = loadSource('electron/services/conference-fetcher.ts', {
    './db': h.api, './article-matching': matching,
    './publication-policy': loadSource('electron/services/publication-policy.ts'),
    './architecture-proceedings': { syncArchitectureProceedings: async (venue, year, readPage, persist) => {
      visited.push(year)
      for (const paperYear of [year, 2023]) persist({ sourceId: `${venue}:${paperYear}`, doi: '', title: `Research ${paperYear}`, abstract: '', authors: [], publicationDate: String(paperYear), url: '', pdfUrl: '' })
      return { errors: [] }
    } },
    'node-cron': { schedule() {} },
  })
  await conference.syncConferences(true)
  assert.equal(Math.min(...visited), 2024)
  assert.equal(Math.max(...visited), new Date().getFullYear())
  assert.equal(h.db.prepare('SELECT MIN(year) AS year FROM articles').get().year, 2024)
})
