/** 在隔离副本中重跑指定 Bid Workspace 的 S4，并输出确定性验收报告。 */
import { access, cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import {
  assertNoLinkedPath,
  BidWorkspace,
  buildBidStageTask,
  buildEvidenceMappingAcceptanceReport,
  executeEvidenceMapping,
  within,
} from '@deepseek-ai/dsh-bid'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as WebFetchHttp from '@deepseek-ai/dsh-web-fetch-http'
import * as WebSearchTavily from '@deepseek-ai/dsh-web-search-tavily'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'

export interface ReplayBidS4Options {
  workspace: string
  output: string
  dshHome: string
  provider: string
  model: string
  sections: string[]
  maxConcurrency: number
  maxRepairAttempts: number
  timeoutMs: number
}

const S4_RESET_PATHS = [
  'analysis/evidence-mapping-plan.json',
  'analysis/evidence-mapping-log.json',
  'analysis/evidence-mapping-checkpoint.json',
  'analysis/evidence-map.candidate.json',
  'analysis/evidence-mapping-quality.candidate.json',
  'analysis/evidence-map.json',
  'analysis/web-evidence-sources.json',
  'analysis/web-sources',
  'outline/refined-outline.candidate.json',
  'outline/draft.json',
  'outline/outline.json',
  'outline/quality-report.json',
  'outline/confirmed-outline.json',
  'outline/confirmation.json',
  'chapters',
  'output',
] as const

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 需要一个值`)
  return value
}

function positiveInteger(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} 必须是正整数`)
  return value
}

function nonnegativeInteger(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${flag} 必须是非负整数`)
  return value
}

/**
 * 解析 S4 回放参数。
 * @param argv 不含 node 与脚本路径的参数。
 * @param cwd 相对路径的解析基准。
 * @returns 完整回放配置。
 */
export function parseReplayBidS4Args(argv: readonly string[], cwd = process.cwd()): ReplayBidS4Options {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    if (flag === undefined || !flag.startsWith('--')) throw new Error(`未知参数：${flag ?? ''}`)
    values.set(flag, requiredValue(argv, index, flag))
  }
  const known = new Set(['--workspace', '--output', '--dsh-home', '--provider', '--model', '--sections',
    '--max-concurrency', '--repair-attempts', '--timeout-ms'])
  const unknown = [...values.keys()].filter(key => !known.has(key))
  if (unknown.length > 0) throw new Error(`未知参数：${unknown.join('、')}`)
  const workspace = values.get('--workspace')
  const output = values.get('--output')
  if (workspace === undefined || output === undefined) {
    throw new Error('用法：pnpm run bid:s4-replay -- --workspace <S1-S3 Workspace> --output <隔离输出目录> [--sections SEC-A,SEC-B]')
  }
  const absolute = (value: string) => isAbsolute(value) ? resolve(value) : resolve(cwd, value)
  return {
    workspace: absolute(workspace),
    output: absolute(output),
    dshHome: absolute(values.get('--dsh-home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')),
    provider: values.get('--provider') ?? 'deepseek-official',
    model: values.get('--model') ?? 'deepseek-v4-flash',
    sections: (values.get('--sections') ?? '').split(',').map(value => value.trim()).filter(Boolean),
    maxConcurrency: positiveInteger(values.get('--max-concurrency') ?? '3', '--max-concurrency'),
    maxRepairAttempts: nonnegativeInteger(values.get('--repair-attempts') ?? '1', '--repair-attempts'),
    timeoutMs: positiveInteger(values.get('--timeout-ms') ?? '1200000', '--timeout-ms'),
  }
}

/**
 * 复制源项目目录并移除副本中的 S4 及后续产物，保证回放从 S1-S3 状态开始且不修改原 Workspace。
 * @param sourceWorkspace 源工作区。
 * @param outputRoot 新的隔离工作区根目录。
 * @returns 指向隔离副本的 Bid Workspace。
 */
export async function prepareBidS4ReplayWorkspace(sourceWorkspace: BidWorkspace, outputRoot: string): Promise<BidWorkspace> {
  const targetProjectRoot = join(outputRoot, sourceWorkspace.config.projectDirectory)
  const nested = relative(sourceWorkspace.projectRoot, targetProjectRoot)
  if (nested === '' || (!nested.startsWith('..') && !isAbsolute(nested))) {
    throw new Error('回放输出目录不得位于源 .bid-harness 项目目录内')
  }
  try {
    await access(targetProjectRoot)
    throw new Error(`回放目标已存在：${targetProjectRoot}`)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(dirname(targetProjectRoot), { recursive: true })
  await cp(sourceWorkspace.projectRoot, targetProjectRoot, { recursive: true, force: false, errorOnExist: true })
  const replay = new BidWorkspace(outputRoot, sourceWorkspace.config)
  const resetPaths = S4_RESET_PATHS.map(path => within(replay.projectRoot, path))
  for (const path of resetPaths) await assertNoLinkedPath(replay.root, path)
  await Promise.all(resetPaths.map(path => rm(path, { recursive: true, force: true })))
  return replay
}

async function configureReplayRuntime(ctx: Context, options: ReplayBidS4Options): Promise<void> {
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { dshHome: options.dshHome, watch: false })
  await ctx.plugin(LocalCredentialProvider, { dshHome: options.dshHome, watch: false })
  if (options.provider === 'deepseek-official') await ctx.plugin(DeepSeek, {})
  else await ctx.plugin(PiAi, {})
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: join(options.output, '.session-store'), compression: 'none' })
  await ctx.plugin(SystemPrompt, { persona: '仅依据当前 Bid Workspace 的已确认状态、可验证资料与通用 Web 工具执行 S4。' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(WebRuntime, { searchProvider: WebSearchTavily.TAVILY_PROVIDER_ID, fetchProvider: WebFetchHttp.LOCAL_FETCH_PROVIDER_ID })
  await ctx.plugin(WebSearchTavily, {})
  await ctx.plugin(WebFetchHttp, {})
  await ctx.plugin(ToolWeb, { search: true, fetch: true })
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
}

/**
 * 在隔离副本中执行 S4，并将现有执行日志投影为验收报告。
 * @param options 已解析的回放配置。
 * @returns 报告文件绝对路径。
 */
export async function replayBidS4(options: ReplayBidS4Options): Promise<string> {
  const source = new BidWorkspace(options.workspace)
  const workspace = await prepareBidS4ReplayWorkspace(source, options.output)
  const ctx = new Context()
  try {
    await configureReplayRuntime(ctx, options)
    const agent = ctx.agentLoop.create(SessionId(`bid-s4-replay-${Date.now()}`), {
      provider: options.provider,
      model: options.model,
    }, { cwd: options.output })
    await executeEvidenceMapping(agent, workspace, buildBidStageTask('evidence_mapping'), {
      maxConcurrency: options.maxConcurrency,
      maxRepairAttempts: options.maxRepairAttempts,
      signal: AbortSignal.timeout(options.timeoutMs),
    })
    const report = await buildEvidenceMappingAcceptanceReport(workspace, options.sections)
    const reportPath = join(options.output, 's4-acceptance-report.json')
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    return reportPath
  } finally {
    await ctx.fiber.dispose()
  }
}

async function main(): Promise<void> {
  const path = await replayBidS4(parseReplayBidS4Args(process.argv.slice(2)))
  console.info(`S4 回放与验收报告已完成：${path}`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
