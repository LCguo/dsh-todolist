// M11 自测：附件落盘、元数据、上限、删除清理、导入时保留
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoStore, createConfigStore, installApi } from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'todo-m11-'))
const configStore = createConfigStore(join(dir, 'config.json'))
const store = new TodoStore(join(dir, 'todos.json'), 8, configStore)

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

const task = store.add({ content: '写周报', due: '2026-12-01' })
const taskId = task.id

console.log('上传')
const first = store.addAttachment(taskId, { name: '周报模板.txt', mime: 'text/plain', data: Buffer.from('hello') })
check('返回 ok', first.ok === true, first)
check('元数据带回 id/name/size', first.ok && first.attachment.id && first.attachment.name === '周报模板.txt' && first.attachment.size === 5)
const firstFile = join(dir, 'attachments', taskId, first.attachment.file)
check('文件已落盘', existsSync(firstFile))
check('任务里能读到元数据', store.listAttachments(taskId).length === 1)
check('列表不返回字节', store.listAttachments(taskId)[0].data === undefined)

console.log('读取')
const read = store.attachmentFile(taskId, first.attachment.id)
check('读回内容一致', read !== null && read.data.toString('utf8') === 'hello')
check('未知附件返回 null', store.attachmentFile(taskId, 'nope0000') === null)

console.log('校验')
check('空文件被拒', store.addAttachment(taskId, { name: 'a.txt', data: Buffer.alloc(0) }).ok === false)
check('没有文件名被拒', store.addAttachment(taskId, { name: '   ', data: Buffer.from('x') }).ok === false)
check('超大文件被拒', store.addAttachment(taskId, { name: 'big.bin', data: Buffer.alloc(21 * 1024 * 1024) }).ok === false)
check('任务不存在被拒', store.addAttachment('nope0000', { name: 'a.txt', data: Buffer.from('x') }).ok === false)
check('路径穿越 id 被拒', store.addAttachment('../../etc', { name: 'a.txt', data: Buffer.from('x') }).ok === false)

console.log('名字清洗')
const risky = store.addAttachment(taskId, { name: '../../etc/passwd', data: Buffer.from('x') })
check('去掉路径只看文件名', risky.ok && risky.attachment.name === 'passwd', risky)
check('落盘名不含斜杠', risky.ok && !risky.attachment.file.includes('/') && !risky.attachment.file.includes('\\'))

console.log('数量上限')
let tenth = null
for (let i = 0; i < 8; i++) tenth = store.addAttachment(taskId, { name: `第${i}.txt`, data: Buffer.from('x') })
check('10 个附件都成功', store.listAttachments(taskId).length === 10, store.listAttachments(taskId).length)
const overflow = store.addAttachment(taskId, { name: '第11个.txt', data: Buffer.from('x') })
check('第 11 个被拒', overflow.ok === false && /最多/.test(overflow.message), overflow)

console.log('删除单个附件')
const removed = store.removeAttachment(taskId, risky.attachment.id)
check('删除成功', removed.ok === true)
check('文件已删', !existsSync(join(dir, 'attachments', taskId, risky.attachment.file)))
check('元数据剩 9 个', store.listAttachments(taskId).length === 9)
check('重复删除被拒', store.removeAttachment(taskId, risky.attachment.id).ok === false)

console.log('删除任务清附件')
const doomed = store.add({ content: '临时任务' })
store.addAttachment(doomed.id, { name: 'tmp.txt', data: Buffer.from('x') })
check('删除前有目录', existsSync(join(dir, 'attachments', doomed.id)))
const removedTask = store.remove(doomed.id)
check('任务删除成功', removedTask.ok === true)
check('附件目录已清', !existsSync(join(dir, 'attachments', doomed.id)))

console.log('导入行为')
store.importData({ schemaVersion: 2, tasks: [{ id: taskId, title: '写周报（改）', status: 'doing' }] }, 'merge')
check('覆盖导入保留本地附件', store.listAttachments(taskId).length === 9)
store.importData({ schemaVersion: 2, tasks: [{ id: 'imp00001', title: '导入的任务' }] }, 'merge')
check('新导入任务没有附件', store.listAttachments('imp00001').length === 0)

console.log('HTTP 接口')
{
  let handler
  const ctx = { webServer: { register(options) { handler = options.handler; return () => {} } } }
  installApi(ctx, { store, config: { maxListView: 8 }, configStore })

  const callRaw = async (method, path, { headers = {}, body = [] } = {}) => {
    const req = {
      method,
      url: path,
      headers,
      async *[Symbol.asyncIterator]() {
        for (const chunk of body) yield chunk
      },
    }
    const out = { status: 0, headers: {}, data: null, text: null }
    const res = {
      setHeader(key, value) { out.headers[key.toLowerCase()] = value },
      set statusCode(value) { out.status = value },
      get statusCode() { return out.status },
      end(payload) {
        if (Buffer.isBuffer(payload)) { out.data = payload; return }
        out.data = Buffer.from(String(payload))
        try { out.text = JSON.parse(String(payload)) } catch { out.text = String(payload) }
      },
    }
    await handler(req, res)
    return out
  }

  const apiTask = store.add({ content: '接口附件任务' }).id
  const payload = Buffer.from('attachment-bytes')
  const name = encodeURIComponent('说明.txt')
  const uploaded = await callRaw('POST', `/todolist/api/attachment?id=${apiTask}`, {
    headers: { 'x-attachment-name': name, 'content-type': 'text/plain' },
    body: [payload],
  })
  check('上传返回 200', uploaded.status === 200, uploaded.status)
  check('返回附件元数据', uploaded.text?.ok === true && uploaded.text.attachment.name === '说明.txt', uploaded.text)
  const attachmentId = uploaded.text?.attachment?.id

  const fetched = await callRaw('GET', `/todolist/api/attachment?id=${apiTask}&aid=${attachmentId}`)
  check('下载返回 200', fetched.status === 200, fetched.status)
  check('下载内容一致', fetched.data?.toString('utf8') === 'attachment-bytes')
  check('带 content-disposition', /inline; filename=/.test(fetched.headers['content-disposition'] ?? ''))

  const missing = await callRaw('GET', `/todolist/api/attachment?id=${apiTask}&aid=nope0000`)
  check('不存在的附件返回 404', missing.status === 404, missing.status)

  const noId = await callRaw('POST', '/todolist/api/attachment', { headers: {}, body: [payload] })
  check('缺 id 上传返回 400', noId.status === 400, noId.status)

  const removedOverHttp = await callRaw('POST', '/todolist/api/attachment/remove', {
    headers: { 'content-type': 'application/json' },
    body: [Buffer.from(JSON.stringify({ id: apiTask, attachmentId }))],
  })
  check('删除返回 200', removedOverHttp.status === 200, removedOverHttp.status)
  check('删除后元数据为空', store.listAttachments(apiTask).length === 0)

  // 打开接口：只验证「找不到就 404」，不真的去启动系统程序
  const openMissing = await callRaw('POST', '/todolist/api/attachment/open', {
    headers: { 'content-type': 'application/json' },
    body: [Buffer.from(JSON.stringify({ id: apiTask, attachmentId: 'nope0000' }))],
  })
  check('打开不存在的附件返回 404', openMissing.status === 404, openMissing.status)
  check('404 带说明', /已丢失|不存在/.test(openMissing.text?.message ?? ''), openMissing.text)
}

console.log('打开用的本地路径')
{
  const taskId2 = store.add({ content: '打开路径任务' }).id
  const up = store.addAttachment(taskId2, { name: '清单.txt', mime: 'text/plain', data: Buffer.from('x') })
  const openPath = store.attachmentOpenPath(taskId2, up.attachment.id)
  check('返回绝对路径', typeof openPath === 'string' && openPath.includes('attachments'), openPath)
  check('路径落在任务附件目录', openPath !== null && openPath.includes(taskId2))
  check('未知附件返回 null', store.attachmentOpenPath(taskId2, 'nope0000') === null)
  check('未知任务返回 null', store.attachmentOpenPath('nope0000', up.attachment.id) === null)
  check('非法 id 返回 null', store.attachmentOpenPath('../../etc', up.attachment.id) === null)

  // 元数据被手改成越界路径时：读取时会规范化回目录内，不会真的打开目录外的文件
  const items = store.all()
  const target = items.find((it) => it.id === taskId2)
  target.attachments[0].file = '..\\..\\evil.txt'
  store.save(items)
  const afterTraversal = store.attachmentOpenPath(taskId2, up.attachment.id)
  const insideDir = typeof afterTraversal === 'string' && afterTraversal.startsWith(join(dir, 'attachments', taskId2))
  check('越界文件名被规范化回附件目录', insideDir && !afterTraversal.includes('evil'), afterTraversal)

  // 文件被外部删掉时也不能打开
  const items2 = store.all()
  const target2 = items2.find((it) => it.id === taskId2)
  target2.attachments[0].file = up.attachment.file
  store.save(items2)
  rmSync(join(dir, 'attachments', taskId2), { recursive: true, force: true })
  check('文件已丢失返回 null', store.attachmentOpenPath(taskId2, up.attachment.id) === null)
}

console.log('旧数据迁移')
const legacyDir = mkdtempSync(join(tmpdir(), 'todo-m11-legacy-'))
const legacyFile = join(legacyDir, 'todos.json')
writeFileSync(legacyFile, JSON.stringify({ version: 1, items: [{ id: 'legacy01', content: '老任务' }] }), 'utf8')
const legacyStore = new TodoStore(legacyFile, 8, createConfigStore(join(legacyDir, 'config.json')))
check('缺 attachments 字段自动补空数组', Array.isArray(legacyStore.findById('legacy01')?.attachments))

rmSync(dir, { recursive: true, force: true })
rmSync(legacyDir, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
