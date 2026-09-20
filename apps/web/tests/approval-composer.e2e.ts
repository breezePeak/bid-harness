// Web e2e scenario: the structured approval panel under a long
// command. The shipped composition confines bash through the sandbox policy
// and routes its escalation through the approval seam, so a read-only session
// asked to write a file produces a REAL pending approval — the panel renders
// in the browser, the test measures its geometry, answers through it, and the
// escalated command then runs. Replay is deterministic: the denial, the
// escalation retry and its command text arrive from replayed chunks, and the
// answer click is the test's own gesture (the same sanctioned reaction to
// model content as the question composer: the turn cannot complete without it).
//
// Geometry is the point of the scenario. The command is unbounded model text,
// and an uncapped card grows with it until the refuse/allow buttons leave the
// viewport — an approval the user could see and not answer.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { deriveReplayScript, parseSessionLog, type ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Empty type import: carries the approval package's session-event merge, so
// the decided-outcome assertion below type-checks against the real union.
import type {} from '@deepseek-ai/dsh-user-approval'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/approval-composer', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
// The scenario's one golden: the waiting panel. Everything the answered state
// proves is asserted directly — see the world-state block at the end.
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()

// Irreducible payload: the command has to be long enough to pass the card's
// height cap, which is the only command length that reproduces an action row pushed off
// screen. Unrelated tokens, not a repeated word — a repeated word is what the
// model compressed into `printf 'alpha %.0s' {1..400}` while recording, and a
// short command proves nothing here. The formula keeps the source small; the
// model receives the expanded literal it has to put in the command.
const TOKENS = Array.from({ length: 220 }, (_, index) => `tok${((index + 1) * 7919 % 99991).toString(36)}`).join(' ')
const PROMPT = `Write a file named notes.txt in the workspace containing exactly this text on one line: ${TOKENS}. Use one bash command with the literal text inline. Then reply with the single word DONE and stop.`

/** Draft used to measure the composer's own text cap: enough lines to pass it. */
const CAP_PROBE = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n')

function replaceToolCall(entry: ReplayEntry, name: string, argumentsJson: string): ReplayEntry {
  if (entry.kind !== 'chunks') throw new Error('approval replay tool call must be a completed chunk entry')
  let wroteArguments = false
  const chunks = entry.chunks.flatMap((chunk): StreamChunk[] => {
    if (chunk.type === 'tool-call-delta') {
      if (wroteArguments) return []
      wroteArguments = true
      return [{ ...chunk, name, argumentsDelta: argumentsJson }]
    }
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
      return [{ ...chunk, block: { ...chunk.block, name, arguments: argumentsJson } }]
    }
    return [chunk]
  })
  return { kind: 'chunks', chunks }
}

async function windowsReplayOverride(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-web-approval-'))
  const path = join(directory, 'replay.override.json')
  const replay = deriveReplayScript(parseSessionLog(await readFile(FIXTURE, 'utf8')))
  if (replay.length < 2) throw new Error('approval replay must contain the initial and escalated shell calls')
  const command = `Set-Content -LiteralPath notes.txt -Value '${TOKENS}' -NoNewline`
  replay[0] = replaceToolCall(replay[0]!, 'pwsh', JSON.stringify({
    command,
    description: 'Write notes.txt with the specified text',
  }))
  replay[1] = replaceToolCall(replay[1]!, 'pwsh', JSON.stringify({
    description: 'Write notes.txt with the specified text',
    command,
    sandbox_permissions: 'workspace-write',
    justification: 'Need to write the notes.txt file as requested by the user.',
  }))
  await writeFile(path, JSON.stringify(replay))
  return { directory, path }
}

describe('web e2e: approval interaction keeps its actions reachable', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let overrideDirectory: string | undefined
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    const override = MODE !== 'record' && process.platform === 'win32'
      ? await windowsReplayOverride()
      : undefined
    overrideDirectory = override?.directory
    scaffold = await launchWebScaffold(MODE === 'record' ? {} : {
      replayFixture: FIXTURE,
      paceMs: 15,
      ...(override === undefined ? {} : { replayOverride: override.path }),
    })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (overrideDirectory !== undefined) await rm(overrideDirectory, { recursive: true, force: true })
  })

  it('caps the long command, answers through the panel, and runs the escalated command', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-approval'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })

    // The composer's own text cap, measured on the live draft scrollport before
    // the approval appears — the box that carries the cap, while the
    // textarea inside it is as tall as the whole draft. The panel's scroll
    // region must stop at the same height (the designer's requirement: one cap
    // for the composer seat), and measuring it here keeps the assertion free of
    // the px value itself.
    await input.fill(CAP_PROBE)
    const composerCap = await input.evaluate(el => el.closest('[data-input-scroll]')?.clientHeight ?? 0)
    expect(composerCap).toBeGreaterThan(0)
    await input.fill('')

    // Read-only: the mode whose denial the model escalates from. Switched
    // through the shipped access-mode chip, not a test-only override.
    await page.locator('[aria-label^="Access mode"]').click()
    await page.getByRole('menuitem', { name: 'Read Only' }).click()
    await expect.poll(
      () => page.locator('[aria-label="Access mode, current: Read Only"]').count(),
      { timeout: 15_000 },
    ).toBe(1)

    const settled = scaffold.whenTurnSettled(MODE === 'record' ? 240_000 : 60_000)
    await input.fill(PROMPT)
    await input.press('Enter')

    // The approval panel stays above the ordinary composer while the tool waits.
    const panel = page.locator('[data-approval-key]')
    await panel.waitFor({ timeout: MODE === 'record' ? 180_000 : 60_000 })
    const ordinaryInput = page.locator('[data-composer-card] textarea')
    await expect.poll(async () => ordinaryInput.isVisible(), { timeout: 10_000 }).toBe(true)
    await expect.poll(async () => ordinaryInput.isEnabled(), { timeout: 10_000 }).toBe(true)
    const scroll = panel.locator('[data-approval-scroll]')
    await expect.poll(() => scroll.getByText(/tok/).count(), { timeout: 15_000 }).toBeGreaterThan(0)

    if (MODE !== 'record') {
      // This golden owns the stable waiting surface; the answered golden below
      // owns the resulting transcript.
      if (process.platform !== 'win32') {
        const snapshot = await captureStableAria(page, '[data-approval-key]', scaffold.workspaceCwd)
        await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
      }

      // The uncapped-card hazard the header names, measured at the lane
      // baseline and at a short viewport, on the live panel.
      const original = page.viewportSize() ?? { width: 1680, height: 1000 }
      for (const height of [1000, 700]) {
        await page.setViewportSize({ width: 900, height })
        const geometry = await panel.evaluate((root) => {
          const region = root.querySelector<HTMLElement>('[data-approval-scroll]')
          const card = region?.parentElement ?? null
          // Role/text, not the CSS-module class names: the built client hashes those.
          const buttons = [...root.querySelectorAll<HTMLElement>('button')]
          const rows = buttons.map(button => button.getBoundingClientRect())
          return {
            buttons: buttons.length,
            capped: region === null ? 0 : region.clientHeight,
            // A scrolling region proves the cap is genuinely engaged; without
            // it every assertion below would hold vacuously.
            scrolls: region === null ? false : region.scrollHeight > region.clientHeight,
            cardBottom: card === null ? Number.NaN : card.getBoundingClientRect().bottom,
            actionsTop: Math.min(...rows.map(rect => rect.top)),
            actionsBottom: Math.max(...rows.map(rect => rect.bottom)),
            viewport: window.innerHeight,
          }
        })
        expect(geometry.buttons).toBe(2)
        expect(geometry.scrolls).toBe(true)
        // One cap for the seat: the panel's text region stops where the
        // composer draft does (sub-pixel tolerance for the shared padding).
        expect(Math.abs(geometry.capped - composerCap)).toBeLessThan(1)
        // Both buttons stay inside the card AND inside the viewport — the
        // answerable state the cap exists to guarantee.
        expect(geometry.actionsTop).toBeGreaterThan(0)
        expect(geometry.actionsBottom).toBeLessThanOrEqual(geometry.viewport)
        expect(geometry.actionsBottom).toBeLessThanOrEqual(geometry.cardBottom)
      }
      await page.setViewportSize(original)
    }

    await panel.getByRole('button', { name: 'Allow once' }).click()

    const sessionId = await settled
    if (MODE === 'record') {
      await recordFixture(scaffold, sessionId, FIXTURE)
      return
    }
    // World state: the granted escalation is what let the command run, and the
    // panel leaves with the regular composer restored. Asserted on the world
    // and the DOM rather than through a transcript golden — the denied first
    // attempt renders the OS's own refusal ("Operation not permitted" on
    // macOS, "Read-only file system" on Linux), so the answered transcript is
    // not a platform-neutral golden surface.
    expect(JSON.stringify(sessionEvents.filter(e => e.type === 'approval/decided').at(-1)))
      .toContain('allowed-once')
    const written = await readFile(join(scaffold.workspaceCwd, 'workspace', 'notes.txt'), 'utf8')
    expect(written).toContain(TOKENS.slice(0, 64))
    await expect.poll(() => page.getByText('DONE', { exact: true }).count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(1)
    expect(await page.locator('[data-approval-key]').count()).toBe(0)
    await expect.poll(() => page.locator('textarea').first().isEnabled(), { timeout: 10_000 }).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 300_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl', 'ui.expected.md'])
  })
})
