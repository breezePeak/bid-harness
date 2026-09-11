/** 固定真实 Child 的修复对话、工具执行与 Host 最终来源绑定。 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionSnapshot } from '@deepseek-ai/dsh-acp-snapshot'
import { parseEvidenceMapArtifact, parseOutlineArtifact, parseWebEvidenceSourcesArtifact } from '@deepseek-ai/dsh-bid'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./bid-evidence-mapping-snapshots/', import.meta.url))
const configPath = fileURLToPath(new URL('../bid-evidence-mapping.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/bid-evidence-mapping-driver.ts', import.meta.url))
it('corrects S4 tool arguments in one Child turn through the headless Loader', async () => {
  const result = await runLoaderSmoke({
    label: 'S4 同 Child Web 证据修复',
    tempDirPrefix: 'dsh-s4-web-snapshot-',
    binScript,
    configPath,
    mode: 'src',
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    inspect: async (cwd) => {
      const store = join(cwd, '.session-store')
      const paths = (await readdir(store, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      const logs = await Promise.all(paths.map(async path => readFile(join(store, path), 'utf8')))
      const childLogs = logs.filter(log => (JSON.parse(log.split('\n')[0]!) as SessionHeader).parentSession !== undefined)
      expect(childLogs).toHaveLength(4)
      const childLog = childLogs.find(log => /"type":"tool\/call".*"name":"web_search"/u.test(log))
      if (childLog === undefined) throw new Error('缺少持久化 Child 日志')
      const [headerLine, ...eventLines] = childLog.trimEnd().split('\n')
      const header = JSON.parse(headerLine!) as SessionHeader
      const events = eventLines.map(line => JSON.parse(line) as SessionEvent)
      const calls = events.filter(event => event.type === 'tool/call')
        .filter(event => event.data.name === 'web_search' || event.data.name === 'web_fetch')
      expect(calls.map(event => [event.data.name, event.data.turn])).toEqual([['web_search', 1], ['web_fetch', 1]])
      expect(childLog).toContain('web_materials.0.url')
      expect(childLog).toContain('search-unknown-scope')
      expect(childLog).toContain('read-forged-path')
      expect(childLog).toContain('search_sources')
      expect(childLog).toContain('read_source')
      expect(childLog).toContain('update_section_task')
      expect(childLog).toContain('submit_section_research_assessment')
      expect(childLog).toContain('lock_section_outline')
      expect(childLog).toContain('lock-before-research-ready')
      expect(childLog).toContain('research-not-ready')
      expect(childLog).toContain('research-ready')
      expect(childLog).toContain('lock-without-comparison')
      expect(childLog).toContain('RF-ff8a1adbc819d315')
      expect(events.find(event => event.type === 'tool/result'
        && event.data.message.source.kind === 'tool' && event.data.message.source.callId === 'lock-before-research-ready'))
        .toMatchObject({ data: { error: { code: 'INVALID_ARGS' } } })
      expect(events.find(event => event.type === 'tool/result'
        && event.data.message.source.kind === 'tool' && event.data.message.source.callId === 'lock-without-comparison'))
        .toMatchObject({ data: { error: { code: 'INVALID_ARGS' } } })
      expect(childLog).toContain('global_outline_index：')
      expect(childLog).toContain('current_section_scope：')
      expect(childLog).toContain('current_section_baseline：')
      expect(childLog).toContain('scoped_diffs：')
      expect(childLog).toContain('scoped_candidate_refs：')
      expect(childLog).not.toContain('当前整本目录与章节职责：')
      expect(childLog).not.toContain('全局候选资料池：')
      expect(childLog).toContain('用户原始目录框架：')
      expect(childLog).toContain('资产发现')
      expect(childLog).toContain('资产核验')
      expect(childLog).toContain('read-forbidden-framework')
      expect(childLog).not.toContain('框架内部编写说明。')
      expect(childLog).toContain('参考旧标书完整目录：')
      expect(childLog).toContain('输入旧标按身份治理与安全运维组织')
      expect(childLog).toContain('submit_section_mapping')
      expect(childLog).toContain('finish_mapping_task')
      expect(childLog).not.toContain('submit_evidence_mapping')
      expect(childLog).toContain('reference_bid')
      expect(childLog).toContain('INVALID_ARGS')
      expect(events.find(event => event.type === 'tool/result')).toMatchObject({ data: { message: { content: [{ isError: true }] } } })
      expect(childLog).toContain('read_source')
      expect(childLog).not.toContain('需要访问控制与安全审计方案。')
      expect(childLog).toContain('本地资料只有实施流程。')
      expect(childLog).not.toContain('EISDIR')
      const finalCheckLog = childLogs.find(log => log.includes('MAP-FINAL-CHECK'))
      if (finalCheckLog === undefined) throw new Error('缺少持久化 Final Check 日志')
      const [finalHeaderLine, ...finalEventLines] = finalCheckLog.trimEnd().split('\n')
      const finalHeader = JSON.parse(finalHeaderLine!) as SessionHeader
      const finalEvents = finalEventLines.map(line => JSON.parse(line) as SessionEvent)
      expect(finalEvents.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['finish_final_check', 'list_review_items', 'review_items', 'finish_final_check'])
      expect(finalCheckLog).toContain('pending_review_items：')
      expect(finalCheckLog).toContain('pending_web_refs：')
      expect(finalCheckLog).not.toContain('当前章节资料与已知缺口：')
      expect(finalCheckLog).toContain('https://official.example/standard')
      const refinementLogs = childLogs.filter(log => log.includes('submit-refinement-'))
      expect(refinementLogs).toHaveLength(2)
      const rejectedRefinementLog = refinementLogs.find(log => log.includes('submit-refinement-incomplete'))
      const acceptedRefinementLog = refinementLogs.find(log => log.includes('submit-refinement-quality'))
      if (rejectedRefinementLog === undefined || acceptedRefinementLog === undefined) throw new Error('缺少隔离目录复核及修复日志')
      expect(rejectedRefinementLog).toContain('submit-refinement-incomplete')
      expect(acceptedRefinementLog).toContain('submit-refinement-quality')
      expect(refinementLogs.every(log => !log.includes('tool/call') || log.includes('structured_output'))).toBe(true)

      const projectRoot = join(cwd, '.bid-harness')
      const outline = parseOutlineArtifact(JSON.parse(await readFile(join(projectRoot, 'outline/outline.json'), 'utf8')))
      expect(outline.sections[0]).toMatchObject({
        purpose: '为访问控制项目说明权限控制与安全审计措施，响应安全技术评分。',
        writing_notes: ['分别说明身份鉴别、权限授予和审计记录的执行方法。'],
        suggested_tables: ['角色权限与审计记录对照表'],
      })
      const map = parseEvidenceMapArtifact(JSON.parse(await readFile(join(projectRoot, 'analysis/evidence-map.json'), 'utf8')))
      const checkpoint = JSON.parse(await readFile(join(projectRoot, 'analysis/evidence-mapping-checkpoint.json'), 'utf8')) as {
        schema_version: number
        tasks: Array<{ task_id: string; research_assessment?: { sufficient_for_outline_decision: boolean; unresolved_gaps: unknown[] } }>
      }
      expect(checkpoint.schema_version).toBe(9)
      expect(checkpoint.tasks.find(task => task.task_id.startsWith('MAP-INIT-'))?.research_assessment)
        .toMatchObject({
          sufficient_for_outline_decision: true,
          unresolved_gaps: [expect.objectContaining({ affects_outline_decision: false })],
        })
      const ledger = parseWebEvidenceSourcesArtifact(JSON.parse(await readFile(join(projectRoot, 'analysis/web-evidence-sources.json'), 'utf8')))
      expect(ledger.sources).toHaveLength(1)
      expect(map.section_mappings[0]!.web_materials[0]).toMatchObject({
        source_id: ledger.sources[0]!.source_id, snapshot_path: ledger.sources[0]!.snapshot_path,
      })
      const snapshots = await Promise.all(ledger.sources.map(source => readFile(join(projectRoot, source.snapshot_path), 'utf8')))
      const artifacts = JSON.stringify({
        outline, map, ledger: { ...ledger, sources: ledger.sources.map(source => ({ ...source, fetched_at: '<TIME>' })) }, snapshots,
      }, null, 2) + '\n'
      const refinementHeaders = refinementLogs.map(log => JSON.parse(log.split('\n')[0]!) as SessionHeader)
      const sessionIds = [header.parentSession!, header.id, finalHeader.id, ...refinementHeaders.map(item => item.id)]
      const transcript = normalizeSessionSnapshot(childLog, { sessionIds, cwd, cwdAliases: [cwd.replaceAll('\\', '/')] })
      const finalCheck = normalizeSessionSnapshot(finalCheckLog, { sessionIds, cwd, cwdAliases: [cwd.replaceAll('\\', '/')] })
      const rejectedRefinement = normalizeSessionSnapshot(rejectedRefinementLog, { sessionIds, cwd, cwdAliases: [cwd.replaceAll('\\', '/')] })
      const refinement = normalizeSessionSnapshot(acceptedRefinementLog, { sessionIds, cwd, cwdAliases: [cwd.replaceAll('\\', '/')] })
      const expected = {
        'child.expected.jsonl': transcript,
        'refinement-rejected.expected.jsonl': rejectedRefinement,
        'refinement.expected.jsonl': refinement,
        'final-check.expected.jsonl': finalCheck,
        'artifacts.expected.json': artifacts,
      }
      if (process.env.DSH_SNAPSHOT === 'refresh') {
        await mkdir(fixtureDir, { recursive: true })
        for (const [name, content] of Object.entries(expected)) await writeFile(join(fixtureDir, name), content)
      }
      for (const [name, content] of Object.entries(expected)) expect(content).toBe(await readFile(join(fixtureDir, name), 'utf8'))
    },
  })
  expect(JSON.parse(result.stdout)).toEqual({
    stage: 'evidence_mapping', status: 'waiting_user',
    state_files: ['evidence-mapping-checkpoint.json', 'evidence-mapping-plan.json'],
  })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
