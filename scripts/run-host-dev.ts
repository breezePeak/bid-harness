/** Build Host packages before starting a source-checkout runtime. */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pnpmInvocation } from './pnpm-invocation.ts'

const root = resolve(import.meta.dirname, '..')
const target = process.argv[2]
const targetArgs = process.argv.slice(3)

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (target !== 'dsh' && target !== 'bid:s4-replay') {
  throw new Error(`未知开发运行目标：${target ?? ''}`)
}

const pnpm = pnpmInvocation(['run', 'build:lib:host'])
run(pnpm.command, pnpm.args)
run(process.execPath, ['--import', 'tsx/esm', 'scripts/verify-bid-web-tool-name.ts'])
run(process.execPath, [
  '--import', 'tsx/esm',
  target === 'dsh' ? 'apps/cli/src/bin.ts' : 'scripts/replay-bid-s4.ts',
  ...targetArgs,
])
