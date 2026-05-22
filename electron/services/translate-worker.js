const fs = require('fs')
const { execSync } = require('child_process')
const { tmpdir } = require('os')
const { join } = require('path')

process.stdin.setEncoding('utf-8')
let input = ''
process.stdin.on('data', chunk => input += chunk)
process.stdin.on('end', () => {
  try {
    const req = JSON.parse(input)
    const body = JSON.stringify({
      model: 'gemma3:4b',
      prompt: req.prompt,
      stream: false,
      format: 'json',
      options: { temperature: 0.1, num_predict: 1024 },
    })

    // 写请求到临时文件
    const tmpFile = join(tmpdir(), `ollama_${Date.now()}.json`)
    fs.writeFileSync(tmpFile, body, 'utf-8')

    // 用 curl 调 Ollama，失败自动重试一次
    let stdout
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        stdout = execSync(
          `curl -sS --max-time 300 http://127.0.0.1:11434/api/generate -H "Content-Type: application/json" --data-binary @${tmpFile}`,
          { timeout: 300_000, maxBuffer: 10 * 1024 * 1024 }
        )
        break
      } catch (e) {
        if (attempt === 1) throw e
        fs.writeSync(2, `[worker] curl retry after: ${e.message}\n`)
      }
    }

    try { fs.unlinkSync(tmpFile) } catch {}

    const j = JSON.parse(stdout.toString())
    process.stdout.write(JSON.stringify({ ok: true, response: j.response || '' }))
    process.exit(0)
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message }))
    process.exit(1)
  }
})
