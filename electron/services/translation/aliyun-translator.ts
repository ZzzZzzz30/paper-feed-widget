import crypto from 'crypto'
import { TranslateInput, TranslateResult } from './types'

function percentEncode(str: string): string {
  return encodeURIComponent(str)
    .replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28')
    .replace(/\)/g, '%29').replace(/\*/g, '%2A').replace(/\+/g, '%20')
}

function getKeyId(): string {
  try {
    const { getDb } = require('../db')
    const row = getDb().prepare("SELECT value FROM settings WHERE key = 'aliyun_access_key_id'").get() as { value?: string } | undefined
    if (row?.value) return row.value
  } catch {}
  return process.env.ALIYUN_ACCESS_KEY_ID || ''
}
function getSecret(): string {
  try {
    const { getDb } = require('../db')
    const row = getDb().prepare("SELECT value FROM settings WHERE key = 'aliyun_access_key_secret'").get() as { value?: string } | undefined
    if (row?.value) return row.value
  } catch {}
  return process.env.ALIYUN_ACCESS_KEY_SECRET || ''
}

async function translateOne(text: string): Promise<string> {
  const keyId = getKeyId()
  const secret = getSecret()
  if (!keyId || !secret) throw new Error('阿里云 AK 未配置')
  const nonce = `${Date.now()}${Math.floor(Math.random() * 99999)}`
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  const params: Record<string, string> = {
    Format: 'JSON', Version: '2018-10-12', SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0', AccessKeyId: getKeyId(),
    Action: 'TranslateGeneral', FormatType: 'text',
    SourceLanguage: 'en', TargetLanguage: 'zh',
    SourceText: text.slice(0, 5000), Scene: 'general',
    Timestamp: timestamp, SignatureNonce: nonce, RegionId: 'cn-hangzhou',
  }

  const sorted = Object.keys(params).sort()
  const qs = sorted.map(k => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&')
  const sts = `POST&${percentEncode('/')}&${percentEncode(qs)}`
  params.Signature = crypto.createHmac('sha1', `${getSecret()}&`).update(sts, 'utf-8').digest('base64')

  // POST body
  const bodyParts = sorted.map(k => `${percentEncode(k)}=${percentEncode(params[k])}`)
  bodyParts.push(`${percentEncode('Signature')}=${percentEncode(params.Signature)}`)
  const body = bodyParts.join('&')

  const resp = await fetch('https://mt.aliyuncs.com/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const data = await resp.json() as { Code?: string; Data?: { Translated?: string }; Message?: string }

  if (data.Code && data.Code !== '200') {
    throw new Error(`Aliyun ${data.Code}: ${data.Message || ''}`)
  }
  return data.Data?.Translated || ''
}

export async function translateWithAliyun(input: TranslateInput): Promise<TranslateResult> {
  const titleCn = await translateOne(input.title)
  const abstractCn = await translateOne(input.abstract.slice(0, 2500))
  console.log(`[Translation] #${input.articleId} aliyun ok: ${titleCn.slice(0,30)}`)
  return { title_cn: titleCn, abstract_cn: abstractCn, provider: 'aliyun' }
}
