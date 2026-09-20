// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BidRevisionFloatingPanel } from '../src/client/BidRevisionFloatingPanel.tsx'

afterEach(cleanup)

const issue = (status: 'completed' | 'failed', id: string) => ({
  issue_id: id,
  section_id: 'SEC-1',
  section_title: '实施方案',
  scope: 'chapter' as const,
  reference: { scope: 'chapter' as const, base_content_sha256: 'a'.repeat(64) },
  instruction: `${status} issue`,
  suggestion: null,
  status,
  batch_id: 'BATCH-1',
  created_at: 1,
  updated_at: 2,
})

describe('BidRevisionFloatingPanel comparison action', () => {
  it('compares only completed history while section titles keep locating normally', async () => {
    const onCompare = vi.fn()
    const onLocate = vi.fn()
    render(<BidRevisionFloatingPanel
      getRevisionQueue={async () => ({ schema_version: 1, revision: 2, issues: [issue('completed', 'DONE'), issue('failed', 'FAILED')] })}
      onCompare={onCompare}
      onLocate={onLocate}
    />)
    fireEvent.click(screen.getByRole('button', { name: '展开批量审核修改' }))
    const compare = await screen.findByRole('button', { name: '对比查看' })
    fireEvent.click(compare)
    expect(onCompare).toHaveBeenCalledWith('DONE', 'SEC-1')
    fireEvent.click(screen.getByRole('button', { name: '查看位置' }))
    expect(onLocate).toHaveBeenCalledWith('SEC-1')
    fireEvent.click(screen.getAllByRole('button', { name: '实施方案' })[0]!)
    expect(onLocate).toHaveBeenCalledTimes(2)
  })
})
