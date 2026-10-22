// M1 自测：/api/config 的读、写、局部合并、异常回退
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installApi, createConfigStore, normalizeConfig } from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'todo-m1-'))
const configStore = createConfigStore(join(dir, 'config.json'))

let handler
const ctx = {
  webServer: {
    register(options) {
      handler = options.handler
      return () => {}
    },
  },
}

installApi(ctx, {
  store: { list: () => ({ items: [], total: 0 }) },
  config: { maxListView: 8 },
  configStore,
})

/** 构造最小 req/res，返回 { status, body }。 */
async function call(method, path, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url: path,
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  }
  const result = { status: 0, body: null }
  const res = {
    setHeader() {},
    set statusCode(value) {
      result.status = value
    },
    get statusCode() {
      return result.status
    },
    end(text) {
      try {
        result.body = JSON.parse(text)
      } catch {
        result.body = text
      }
    },
  }
  await handler(req, res)
  return result
}

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures++
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

console.log('GET /api/config（首次，无文件）')
const got = await call('GET', '/todolist/api/config')
check('200', got.status === 200, got.status)
check('默认 full 档', got.body.config.preset === 'full', got.body.config.preset)
check('含 14 个模块', Object.keys(got.body.config.modules).length === 14)
check('返回 presets 元数据', !!got.body.presets?.minimal)

console.log('PUT /api/config（局部合并）')
const put = await call('PUT', '/todolist/api/config', {
  config: { modules: { 'view.calendar': false }, search: { debounceMs: 800 } },
})
check('200', put.status === 200, put.status)
check('已写入 calendar=false', put.body.config.modules['view.calendar'] === false)
check('已写入 debounce=800', put.body.config.search.debounceMs === 800)
check('未提交的模块保持不变', put.body.config.modules['view.today'] === true)
check('档位回落 custom', put.body.config.preset === 'custom', put.body.config.preset)

console.log('GET 再读（应从文件读取）')
const again = await call('GET', '/todolist/api/config')
check('持久化生效', again.body.config.search.debounceMs === 800)
check('数值夹取（debounce 800 保留）', again.body.config.search.debounceMs === 800)

console.log('文件落盘')
const fileText = readFileSync(join(dir, 'config.json'), 'utf8')
check('config.json 存在且为 JSON', JSON.parse(fileText).modules['view.calendar'] === false)

console.log('非法输入')
const bad = await call('PUT', '/todolist/api/config', {
  config: { search: { debounceMs: 99999, scope: 'nope' }, reminder: { offsets: [7, 15, 15] }, modules: { 'core.list': false } },
})
check('非法 debounce 夹到 1000', bad.body.config.search.debounceMs === 1000)
check('非法 scope 回退 all', bad.body.config.search.scope === 'all')
check('非法提醒点被剔除并去重', JSON.stringify(bad.body.config.reminder.offsets) === '[15]')
check('core.list 强制开启', bad.body.config.modules['core.list'] === true)

console.log('极简预设')
const mini = await call('PUT', '/todolist/api/config', { config: { preset: 'minimal' } })
check('仅 1 个模块开启', Object.values(mini.body.config.modules).filter(Boolean).length === 1)
check('档位为 minimal', mini.body.config.preset === 'minimal')

console.log('损坏文件回退')
const brokenDir = mkdtempSync(join(tmpdir(), 'todo-m1-broken-'))
const brokenFile = join(brokenDir, 'config.json')
const { writeFileSync } = await import('node:fs')
writeFileSync(brokenFile, '{ this is not json')
const fallback = createConfigStore(brokenFile).read()
check('回退默认配置', fallback.preset === 'full', fallback.preset)
check('normalizeConfig 不抛错', normalizeConfig(null).preset === 'full')

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
