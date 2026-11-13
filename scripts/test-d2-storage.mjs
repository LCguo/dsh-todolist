// D2 自测：任务文件读坏时的保护（保留原文件 / 自动恢复 / 只读保护 / 恢复留痕）
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoStore, createConfigStore } from '../lib/index.js'

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}
const newStore = (dir) => new TodoStore(join(dir, 'todos.json'), 8, createConfigStore(join(dir, 'config.json')))
const readLog = (dir) => {
  try {
    return readFileSync(join(dir, 'recovery.log'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

console.log('1. 读坏 + 有可用备份 → 保留原文件并从备份恢复')
{
  const dir = mkdtempSync(join(tmpdir(), 'todo-d2-recover-'))
  const store = newStore(dir)
  store.add({ title: '任务一', due: '2026-11-20' })
  store.add({ title: '任务二' })
  store.add({ title: '任务三', status: 'done' })
  const backupPath = store.backup()
  const backupCount = JSON.parse(readFileSync(backupPath, 'utf8')).items.length

  const broken = '{ "version": 1, "items": [ 这不是 JSON'
  writeFileSync(join(dir, 'todos.json'), broken, 'utf8')
  const before = readdirSync(dir).sort()

  const recovered = newStore(dir)
  const result = recovered.load()
  const health = recovered.healthReport()

  check('进入 recovered 状态', health.state === 'recovered', health)
  check('条数与备份一致', result.items.length === backupCount, { got: result.items.length, backupCount })
  check('恢复后任务文件是合法 JSON', Array.isArray(JSON.parse(readFileSync(join(dir, 'todos.json'), 'utf8')).items))
  const corruptFiles = readdirSync(dir).filter((name) => /^todos-corrupt-.*\.json$/.test(name))
  check('生成了损坏副本', corruptFiles.length === 1, corruptFiles)
  check('副本内容与损坏原文逐字一致', corruptFiles.length === 1 && readFileSync(join(dir, corruptFiles[0]), 'utf8') === broken)
  check('健康信息带恢复时间与备份名', typeof health.backupAt === 'string' && typeof health.backup === 'string', health)
  const log = readLog(dir)
  check('日志记录了「发现损坏」', log.some((entry) => entry.action === 'corrupt-detected'))
  check('日志记录了「已恢复」', log.some((entry) => entry.action === 'recovered'))
  check('恢复后可以继续写入', recovered.add({ title: '恢复后新增' }).ok === true)
  console.log(`  · 目录变化：${before.length} → ${readdirSync(dir).length} 个文件`)
}

console.log('2. 读坏 + 没有备份 → 只读保护，不写盘')
{
  const dir = mkdtempSync(join(tmpdir(), 'todo-d2-readonly-'))
  const broken = '{"version":1,"items":[oops'
  writeFileSync(join(dir, 'todos.json'), broken, 'utf8')
  const statBefore = statSync(join(dir, 'todos.json')).mtimeMs
  const store = newStore(dir)
  const result = store.load()
  const health = store.healthReport()

  check('进入 readonly 状态', health.state === 'readonly', health)
  check('writable=false', health.writable === false)
  check('列表为空且不崩', Array.isArray(result.items) && result.items.length === 0)
  check('add 被拒绝并说明原因', store.add({ title: '不该写进去' }).ok === false && /只读/.test(store.add({ title: 'x' }).message))
  check('update 被拒绝', store.update('nope', { title: 'x' }).readOnly === true)
  check('remove 被拒绝', store.remove('nope').readOnly === true)
  check('importData 被拒绝', store.importData({ tasks: [{ title: 'x' }] }).readOnly === true)
  check('markReminder 被拒绝', store.markReminder('x', 5, '2026-11-13T00:00:00Z').readOnly === true)
  check('备份被拒绝', store.createBackup().readOnly === true)
  check('任务文件一个字节都没变', readFileSync(join(dir, 'todos.json'), 'utf8') === broken)
  check('任务文件修改时间没变', statSync(join(dir, 'todos.json')).mtimeMs === statBefore)
  const log = readLog(dir)
  check('日志记录了「拒绝恢复 / 只读」', log.some((entry) => entry.action === 'readonly'))
  const corruptFiles = readdirSync(dir).filter((name) => /^todos-corrupt-.*\.json$/.test(name))
  check('原文件已另存保留', corruptFiles.length === 1 && readFileSync(join(dir, corruptFiles[0]), 'utf8') === broken, corruptFiles)
}

console.log('3. 正常路径：原子写、无残留临时文件')
{
  const dir = mkdtempSync(join(tmpdir(), 'todo-d2-atomic-'))
  const store = newStore(dir)
  store.add({ title: '正常任务' })
  store.update(store.all()[0].id, { title: '改过' })
  check('没有 .tmp 残留', readdirSync(dir).every((name) => !name.includes('.tmp')))
  check('内容可读回', JSON.parse(readFileSync(join(dir, 'todos.json'), 'utf8')).items[0].title === '改过')
}

console.log('4. 手动从指定备份恢复也留痕')
{
  const dir = mkdtempSync(join(tmpdir(), 'todo-d2-manual-'))
  const store = newStore(dir)
  store.add({ title: '备份里的任务' })
  const backupPath = store.backup()
  const backupName = backupPath.slice(backupPath.lastIndexOf('\\') + 1)
  writeFileSync(join(dir, 'todos.json'), 'broken', 'utf8')
  const recoveredStore = newStore(dir)
  recoveredStore.load()
  check('先自动恢复到备份', recoveredStore.healthReport().state === 'recovered')
  // 再改一份数据并手动回到旧备份
  recoveredStore.add({ title: '恢复后新增的' })
  const outcome = recoveredStore.restoreBackup(backupName)
  check('手动指定备份恢复成功', outcome.ok === true && outcome.count === 1, outcome)
  check('恢复后任务数与备份一致', recoveredStore.all().length === 1)
  check('手动恢复留痕', readLog(dir).some((entry) => entry.action === 'manual-restore'))
  check('不存在的备份被拒绝', recoveredStore.restoreBackup('todos-backup-nope.json').ok === false)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
