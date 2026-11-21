import { safeStorage } from 'electron'
import { getDb, saveNow } from './db'

export const SECRET_SETTING_KEYS = [
  'elsevier_api_key', 'api_key_openai', 'api_key_anthropic', 'deepseek_api_key',
  'aliyun_access_key_id', 'aliyun_access_key_secret',
] as const

const secretKeys = new Set<string>([...SECRET_SETTING_KEYS, 'tencent_secret_id', 'tencent_secret_key'])
const prefix = 'paperfeed:encrypted:v1:'
const environmentKeys: Record<string, string> = {
  elsevier_api_key: 'ELSEVIER_API_KEY',
  api_key_openai: 'OPENAI_API_KEY',
  api_key_anthropic: 'ANTHROPIC_API_KEY',
  deepseek_api_key: 'DEEPSEEK_API_KEY',
  aliyun_access_key_id: 'ALIYUN_ACCESS_KEY_ID',
  aliyun_access_key_secret: 'ALIYUN_ACCESS_KEY_SECRET',
}

export function isSecretSetting(key: string): boolean {
  return secretKeys.has(key)
}

export function hasSecretSetting(key: string): boolean {
  if (!isSecretSetting(key)) return false
  const row = getDb().prepare('SELECT value FROM settings WHERE key=?').get(key) as { value?: string } | undefined
  return !!row?.value || !!process.env[environmentKeys[key]]
}

export function readSecretSetting(key: string): string {
  if (!isSecretSetting(key)) throw new Error(`Not a secret setting: ${key}`)
  const row = getDb().prepare('SELECT value FROM settings WHERE key=?').get(key) as { value?: string } | undefined
  const stored = row?.value || ''
  if (!stored) return ''
  if (!safeStorage.isEncryptionAvailable()) return ''

  if (stored.startsWith(prefix)) {
    try { return safeStorage.decryptString(Buffer.from(stored.slice(prefix.length), 'base64')) }
    catch (error) {
      console.error(`[Secrets] Could not decrypt ${key}`, error)
      return ''
    }
  }

  const encrypted = prefix + safeStorage.encryptString(stored).toString('base64')
  getDb().prepare('UPDATE settings SET value=? WHERE key=?').run(encrypted, key)
  saveNow()
  return stored
}

export function writeSettingValue(key: string, value: string): boolean {
  const db = getDb()
  const current = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value?: string } | undefined
  let stored = value

  if (isSecretSetting(key)) {
    if (value) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，API 密钥未保存')
      if (current?.value?.startsWith(prefix)) {
        try {
          if (safeStorage.decryptString(Buffer.from(current.value.slice(prefix.length), 'base64')) === value) return false
        } catch {}
      }
      stored = prefix + safeStorage.encryptString(value).toString('base64')
    }
  }

  if (current?.value === stored) return false
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, stored)
  return true
}

export function migrateSecretSettings(): void {
  const db = getDb()
  const rows = db.prepare('SELECT key,value FROM settings').all() as Array<{ key: string; value: string }>
  const legacy = rows.filter(row => isSecretSetting(row.key) && row.value && !row.value.startsWith(prefix))
  if (legacy.length === 0) return
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用，无法安全迁移现有 API 密钥；原数据未改动')
  }

  // Do not leave the old plaintext in freed SQLite cells or overflow pages.
  db.exec('PRAGMA secure_delete = ON')
  for (const row of legacy) {
    const encrypted = prefix + safeStorage.encryptString(row.value).toString('base64')
    db.prepare('UPDATE settings SET value=? WHERE key=?').run(encrypted, row.key)
  }
  db.exec('VACUUM')
  saveNow()
  console.log(`[Secrets] Encrypted ${legacy.length} stored API key(s)`)
}

export function getSettingsForRenderer(): Record<string, string> {
  const rows = getDb().prepare('SELECT key,value FROM settings').all() as Array<{ key: string; value: string }>
  const settings: Record<string, string> = {}
  for (const row of rows) {
    // Retain encryption of any legacy Tencent credentials, but hide the retired settings.
    if (row.key.startsWith('tencent_')) continue
    if (isSecretSetting(row.key)) {
      settings[row.key] = ''
      settings[`${row.key}_configured`] = String(hasSecretSetting(row.key))
    } else {
      settings[row.key] = row.value
    }
  }
  for (const key of SECRET_SETTING_KEYS) {
    settings[key] ??= ''
    settings[`${key}_configured`] ??= String(hasSecretSetting(key))
  }
  return settings
}
