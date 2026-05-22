import crypto from 'crypto'
import { TranslateInput, TranslateResult } from './types'

function getSecretId(): string {
  try {
    const { getDb } = require('../db')
    const row = getDb().prepare("SELECT value FROM settings WHERE key = 'tencent_secret_id'").get() as { value?: string } | undefined
    if (row?.value) return row.value
  } catch {}
  return process.env.TENCENT_SECRET_ID || ''
}
function getSecretKey(): string {
  try {
    const { getDb } = require('../db')
    const row = getDb().prepare("SELECT value FROM settings WHERE key = 'tencent_secret_key'").get() as { value?: string } | undefined
    if (row?.value) return row.value
  } catch {}
  return process.env.TENCENT_SECRET_KEY || ''
}

function sha256Hex(data: string): string { return crypto.createHash('sha256').update(data, 'utf-8').digest('hex') }
function hmacSha256(key: string | Buffer, data: string): Buffer { return crypto.createHmac('sha256', key).update(data, 'utf-8').digest() }

async function callTencentApi(action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const secretId = getSecretId()
  const secretKey = getSecretKey()
  if (!secretId || !secretKey) throw new Error('腾讯云 AK 未配置')

  const service = 'tmt', host = 'tmt.tencentcloudapi.com', version = '2018-03-21'
  const timestamp = Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const payload = JSON.stringify(params)
  const canonicalHeaders = 'content-type:application/json; charset=utf-8\nhost:' + host + '\n'
  const signedHeaders = 'content-type;host'
  const hashedPayload = sha256Hex(payload)
  const canonicalRequest = 'POST\n/\n\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + hashedPayload
  const credentialScope = date + '/' + service + '/tc3_request'
  const stringToSign = 'TC3-HMAC-SHA256\n' + timestamp + '\n' + credentialScope + '\n' + sha256Hex(canonicalRequest)
  const kDate = hmacSha256('TC3' + secretKey, date)
  const kService = hmacSha256(kDate, service)
  const kSigning = hmacSha256(kService, 'tc3_request')
  const signature = hmacSha256(kSigning, stringToSign).toString('hex')
  const authorization = 'TC3-HMAC-SHA256 Credential=' + secretId + '/' + credentialScope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature

  const resp = await fetch('https://' + host, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8', 'Host': host,
      'X-TC-Action': action, 'X-TC-Version': version,
      'X-TC-Timestamp': String(timestamp), 'X-TC-Region': 'ap-guangzhou',
      'Authorization': authorization,
    },
    body: payload,
  })
  const data = await resp.json() as { Response?: Record<string, unknown> }
  if (data.Response?.Error) {
    const err = data.Response.Error as { Code: string; Message: string }
    throw new Error('Tencent ' + err.Code + ': ' + err.Message)
  }
  return data.Response || {}
}

export async function checkTencentOpenStatus(): Promise<{ hasOpen: boolean; hasArrearage: boolean }> {
  const res = await callTencentApi('DescribeOpenStatus', {})
  return {
    hasOpen: !!(res.HasOpen),
    hasArrearage: !!(res.HasArrearage),
  }
}

export async function translateWithTencent(input: TranslateInput): Promise<TranslateResult> {
  const titleCn = await translateOne(input.title)
  const abstractCn = await translateOne(input.abstract.slice(0, 2500))
  console.log('[Translation] #' + input.articleId + ' tencent ok: ' + titleCn.slice(0, 30))
  return { title_cn: titleCn, abstract_cn: abstractCn, provider: 'tencent' }
}

async function translateOne(text: string): Promise<string> {
  const res = await callTencentApi('TextTranslate', {
    SourceText: text.slice(0, 5000), Source: 'en', Target: 'zh', ProjectId: 0,
  })
  return (res.TargetText as string) || ''
}
