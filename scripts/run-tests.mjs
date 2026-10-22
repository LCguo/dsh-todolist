// 汇总运行所有自测脚本：i18n 静态检查 + M1~M10 功能测试
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const suites = [
  ['客户端 bundle 冒烟', 'smoke-client.mjs'],
  ['i18n 键完整性', 'check-i18n.mjs'],
  ['M1 配置体系', 'test-m1-api.mjs'],
  ['M2 数据模型', 'test-m2-model.mjs'],
  ['M4 标签', 'test-m4-tags.mjs'],
  ['M7 提醒', 'test-m7-reminder.mjs'],
  ['M8 导入导出', 'test-m8-io.mjs'],
  ['M9 AI 工具', 'test-m9-tools.mjs'],
  ['M10 5000 条压测', 'bench-5000.mjs'],
]

let failed = 0
for (const [label, file] of suites) {
  console.log(`\n===== ${label} (${file}) =====`)
  const outcome = spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit', env: process.env })
  if (outcome.status !== 0) {
    failed++
    console.log(`✗ ${label} 失败（exit ${outcome.status}）`)
  }
}

console.log(`\n===== 汇总 =====`)
console.log(failed === 0 ? `全部 ${suites.length} 组通过` : `${failed} / ${suites.length} 组失败`)
process.exit(failed === 0 ? 0 : 1)
