// 静态检查：client.js 中 t("...") 使用的文案键是否都存在于中文/英文字典
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const used = new Set([...src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'\s*\)/g)].map((m) => m[1]))
for (const m of src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"\s*\)/g)) used.add(m[1])

const zhStart = src.indexOf('var dict_zh_default')
const zhEnd = src.indexOf('var dict_en_default')
const zhOverrideStart = src.indexOf('var zh = {')
const enStart = src.indexOf('var en = {')
const zhOverrideEnd = enStart

const keys = new Set()
const collect = (block) => {
  for (const m of block.matchAll(/"([a-zA-Z0-9_.]+)"\s*:/g)) keys.add(m[1])
}
collect(src.slice(zhStart, zhEnd))
collect(src.slice(zhOverrideStart, zhOverrideEnd))

const enKeys = new Set()
const collectInto = (block, target) => {
  for (const m of block.matchAll(/"([a-zA-Z0-9_.]+)"\s*:/g)) target.add(m[1])
}
collectInto(src.slice(zhEnd, zhOverrideStart), enKeys) // dict_en_default
collectInto(src.slice(enStart, src.indexOf('var inject =')), enKeys) // en 覆盖项

const missingZh = [...used].filter((k) => !keys.has(k)).sort()
const missingEn = [...used].filter((k) => !enKeys.has(k)).sort()

console.log(`used keys: ${used.size}`)
console.log(`missing in zh: ${missingZh.length}${missingZh.length ? '\n  ' + missingZh.join('\n  ') : ''}`)
console.log(`missing in en: ${missingEn.length}${missingEn.length ? '\n  ' + missingEn.join('\n  ') : ''}`)
process.exit(missingZh.length + missingEn.length === 0 ? 0 : 1)
