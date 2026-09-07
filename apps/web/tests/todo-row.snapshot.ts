// @vitest-environment jsdom
// Assembled todo snapshot: boots the real built `packages/client/*/lib/
// client.js` bundles through AppWebEntry's ModuleLoader path against the
// keyless FixtureApiClient transport, opens the fixture session, and pins the
// two surfaces the fixture's parallel plan (turn 74, two items `in_progress`)
// reaches — the `todo_write` tool row and the dock's plan strip — across the
// fixture's running -> cancelled session transition.
//
// The row is pinned as three separate fields on purpose. `summary=` is the
// ellipsized text and `suffix=` is ToolRow's non-shrinking `summarySuffix`
// slot, so a regression that folds the `+N` count back into the summary string
// changes this file even though the concatenated text would read the same; the
// jsdom package suites bench over src and cannot see the bundled registration.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { hasClass, installAssembledBootEnv, mountAssembledApp, REFRESHING_GOLDEN } from './assembled-boot.ts'

const EXPECTED = join(process.cwd(), 'apps/web/tests/snapshots/todo-row/parallel-plan.expected.txt')

installAssembledBootEnv()

/** Normalize the todo row and the plan strip to stable text fields: the row's
 *  title, its truncatable summary, its non-shrinking suffix, then the panel's
 *  per-status header and every list item with its status. */
function todoShape(row: Element, panel: Element): string {
  const pick = (from: Element, name: string): Element[] =>
    [...from.querySelectorAll('*')].filter(el => hasClass(el, name))
  const first = (from: Element, name: string): string =>
    pick(from, name)[0]?.textContent?.trim() ?? '<absent>'
  const items = [...panel.querySelectorAll('[data-status]')]
    .map((item) => {
      const active = item.getAttribute('data-active')
      const activeField = active === null ? '' : ` active=${active}`
      return `item=${item.getAttribute('data-status')}${activeField} ${item.textContent?.trim() ?? ''}`
    })
  return [
    `row=${row.getAttribute('data-tool')}`,
    `title=${first(row, 'title')}`,
    `summary=${first(row, 'summary')}`,
    `suffix=${first(row, 'summarySuffix')}`,
    `panel=${first(panel, 'progress')}`,
    `spinning-glyphs=${pick(panel, 'glyphProgress').length}`,
    `unfinished-glyphs=${pick(panel, 'glyphUnfinished').length}`,
    ...items,
  ].join('\n')
}

describe('assembled todo surfaces', () => {
  it('renders the parallel plan as active only while its session is running', async () => {
    mountAssembledApp()

    const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
    fireEvent.click(await within(tree).findByText('Fixture 历史会话'))
    // The todo turn is the fixture's last, so wait for its keyed row rather
    // than for chat content in general.
    const row = await waitFor(() => {
      const found = document.querySelector('[data-tool="todo_write"]')
      expect(found).not.toBeNull()
      return found!
    }, { timeout: 10_000 })
    // The panel is the standing plan the turn's `todo/write` event feeds; it
    // mounts above the composer, outside the row, and starts collapsed — its
    // list only exists once expanded.
    const panel = await screen.findByTestId('todo-panel', undefined, { timeout: 10_000 })
    const toggle = panel.querySelector('button[aria-expanded]')
    if (toggle === null) throw new Error('the plan strip must expose its expand toggle')
    if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle)

    const active = todoShape(row, panel)
    // The resident fixture is waiting on three question fields and then an
    // approval. Resolve both gates so the ordinary running composer exposes
    // its real session.cancel action.
    for (let index = 0; index < 3; index += 1) {
      fireEvent.click(await screen.findByRole('button', { name: 'Skip this question' }))
    }
    fireEvent.click(await screen.findByRole('button', { name: 'Allow once' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop generating' }))
    await waitFor(() => {
      expect(panel.querySelectorAll('[data-active="false"]')).toHaveLength(2)
      expect(panel.textContent).toContain('2 unfinished')
    })
    const shape = `running\n${active}\n\nstopped\n${todoShape(row, panel)}`
    if (REFRESHING_GOLDEN) {
      mkdirSync(dirname(EXPECTED), { recursive: true })
      writeFileSync(EXPECTED, shape)
    }
    await expect(shape).toMatchFileSnapshot(EXPECTED)
  })
})
