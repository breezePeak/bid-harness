/** Reject the removed Bid S4 tool name in source and generated runtime files. */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const removedName = ['fetch', 'web', 'source'].join('_')
const scanRoots = ['packages/bid/bid/src', 'packages/bid/bid/lib', 'apps/cli/lib']
const sourceExtensions = new Set(['.cjs', '.d.ts', '.js', '.json', '.map', '.mjs', '.ts'])

function filesIn(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesIn(path) : sourceExtensions.has(path.slice(path.lastIndexOf('.'))) ? [path] : []
  })
}

const matches = scanRoots.flatMap(path => filesIn(join(root, path))).flatMap(path => {
  const text = readFileSync(path, 'utf8')
  return text.includes(removedName) ? [path] : []
})

if (matches.length > 0) {
  throw new Error(`Bid S4 已删除工具名仍存在于：${matches.join(', ')}`)
}

const source = readFileSync(join(root, 'packages/bid/bid/src/evidence-mapping-executor.ts'), 'utf8')
if (!source.includes("const MAPPING_AGENT_TOOLS = ['web_search', 'web_fetch'] as const")) {
  throw new Error('Bid S4 Subagent 工具过滤器不是 web_search + web_fetch')
}
