import { describe, expect, it } from 'vitest'
import { buildRevisionDiffRows } from '../src/client/revision-diff.ts'

const body = (...blocks: string[]): string => `# 标题\n\n${blocks.join('\n\n')}\n`
const shape = (before: string, after: string) => buildRevisionDiffRows(before, after)
  .map(({ kind, after: next, before: prior }) => ({ kind, after: next, before: prior }))

describe('revision markdown block diff', () => {
  it('keeps equal blocks aligned and omits the duplicated chapter H1', () => {
    expect(shape(body('AAA', 'BBB'), body('AAA', 'BBB'))).toEqual([
      { kind: 'equal', after: 'AAA', before: 'AAA' },
      { kind: 'equal', after: 'BBB', before: 'BBB' },
    ])
  })

  it('creates an empty before cell for an insertion', () => {
    expect(shape(body('AAA', 'CCC'), body('AAA', 'BBB', 'CCC'))).toEqual([
      { kind: 'equal', after: 'AAA', before: 'AAA' },
      { kind: 'insert', after: 'BBB', before: null },
      { kind: 'equal', after: 'CCC', before: 'CCC' },
    ])
  })

  it('creates an empty after cell for a deletion', () => {
    expect(shape(body('AAA', 'BBB', 'CCC'), body('AAA', 'CCC'))).toEqual([
      { kind: 'equal', after: 'AAA', before: 'AAA' },
      { kind: 'delete', after: null, before: 'BBB' },
      { kind: 'equal', after: 'CCC', before: 'CCC' },
    ])
  })

  it('pairs gap blocks as modifications before insertions', () => {
    expect(shape(body('A', 'B', 'D'), body('A', 'B2', 'C', 'D'))).toEqual([
      { kind: 'equal', after: 'A', before: 'A' },
      { kind: 'modify', after: 'B2', before: 'B' },
      { kind: 'insert', after: 'C', before: null },
      { kind: 'equal', after: 'D', before: 'D' },
    ])
  })

  it('keeps GFM tables, lists, and fenced code as top-level blocks', () => {
    const structured = body('| A |\n| - |\n| B |', '- one\n- two', '```ts\nconst x = 1\n\nconst y = 2\n```')
    const rows = buildRevisionDiffRows(structured, structured)
    expect(rows).toHaveLength(3)
    expect(rows.every(row => row.kind === 'equal')).toBe(true)
    expect(rows[0]?.after).toContain('| A |')
    expect(rows[1]?.after).toContain('- two')
    expect(rows[2]?.after).toContain('const y = 2')
  })
})
