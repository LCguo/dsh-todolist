// 冒烟测试：在最小 Stub 环境里加载 lib/client.js 并执行 apply()，
// 用于捕获模块级/注册期的语法或引用错误（不渲染组件）。
import { readFileSync } from 'node:fs'

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let definition = null
const loadedTags = []
const intervals = []

const makeElement = () => ({
  dataset: {},
  textContent: '',
  parentNode: null,
  remove() {
    this.parentNode = null
  }
})

const windowObject = {
  __ModuleLoader__: {
    load(def) {
      definition = def
    }
  },
  setInterval(fn, ms) {
    intervals.push({ fn, ms })
    return intervals.length
  },
  clearInterval() {},
  setTimeout(fn) {
    return 1
  },
  clearTimeout() {},
  addEventListener() {},
  removeEventListener() {},
  localStorage: {
    getItem: () => null,
    setItem() {}
  },
  innerWidth: 1440,
  Notification: undefined
}

const documentObject = {
  createElement: () => {
    const element = makeElement()
    loadedTags.push(element)
    return element
  },
  querySelectorAll: () => [],
  head: { appendChild: () => {} },
  body: { dataset: {} },
  addEventListener() {},
  removeEventListener() {}
}

class ReactComponent {
  constructor(props) {
    this.props = props
    this.state = {}
  }
  setState() {}
  forceUpdate() {}
}

const reactStub = {
  Component: ReactComponent,
  PureComponent: ReactComponent,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  createElement: () => null,
  Fragment: 'Fragment'
}
const jsxRuntimeStub = { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
const requireStub = (id) => {
  if (id === 'react' || id === 'react-dom' || id.startsWith('react')) return id === 'react' ? reactStub : id === 'react/jsx-runtime' ? jsxRuntimeStub : {}
  return {}
}

// 执行 bundle（只注册工厂，不执行 factory）
new Function('window', 'document', 'require', code)(windowObject, documentObject, requireStub)

if (definition === null) {
  console.error('✗ bundle 未调用 __ModuleLoader__.load')
  process.exit(1)
}

const moduleExports = definition.factory(requireStub)
const exportedKeys = Object.keys(moduleExports ?? {})
console.log(`✓ bundle 加载成功，exports: ${exportedKeys.join(', ')}`)

const registeredSlots = []
const effects = []
const ctx = {
  locale: {
    bind: () => (key) => key,
    register: () => () => {},
    subscribe: () => () => {}
  },
  slots: {
    inject(name, cb) {
      registeredSlots.push(name)
      cb()
      return () => {}
    },
    register(options) {
      registeredSlots.push(`${options.name}${options.key ? `#${options.key}` : options.id ? `#${options.id}` : ''}`)
      return () => {}
    }
  },
  effect(factory, label) {
    effects.push(label)
    const dispose = factory()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  get() {
    return undefined
  },
  layout: { selectPanel() {} },
  tools: { register: () => () => {} },
  systemPrompt: { context: () => () => {} }
}

try {
  moduleExports.apply(ctx, {})
} catch (error) {
  console.error('✗ apply() 抛错：', error)
  process.exit(1)
}

console.log(`✓ apply() 执行成功`)
console.log(`  注册槽位：${[...new Set(registeredSlots)].join(', ')}`)
console.log(`  effects：${[...new Set(effects)].join(', ')}`)
console.log(`  注入的 style 标签：${loadedTags.length} 个`)
console.log(`  定时器：${intervals.length} 个（${intervals.map((item) => `${item.ms}ms`).join(', ')}）`)

const expectedSlots = ['sidebar.panellist', 'main#todolist']
const missing = expectedSlots.filter((name) => !registeredSlots.includes(name))
if (missing.length > 0) {
  console.error(`✗ 缺少预期注册：${missing.join(', ')}`)
  process.exit(1)
}
console.log('\nALL PASS')
