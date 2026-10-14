import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { anchorCache, findViolations } from '../../scripts/verify-md-links.ts'

const root = resolve('deliverables/bid-workbuddy')
const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
  .filter(name => name.endsWith('.md')).map(name => resolve(root, name))
files.push(resolve('.agents/notes/implemented/feature/2026-10-13-workbuddy-bid-skill.md'))
const anchors = anchorCache()
const violations = files.flatMap(file => findViolations(file, anchors))
if (violations.length) throw new Error(JSON.stringify(violations, null, 2))
console.log(`技能和 Agent Note 的 ${files.length} 个 Markdown 文件链接通过。`)
