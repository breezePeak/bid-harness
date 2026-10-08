/** 输入桥接记录的磁盘身份、答案与重启预算。 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { BidWorkspace } from '../src/index.ts'
import { readBidInputRecovery, writeBidInputRecovery, retryableBidInputFailure, type BidInputBinding } from '../src/bid-input-recovery.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const binding: BidInputBinding = { owner_session_id: 'input-owner', work_id: 'input-work',
  request_sha256: 'a'.repeat(64), run_id: 'input-run', question_key: 'input-question', kind: 'capability' }

async function workspace(): Promise<BidWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'bid-input-journal-'))
  roots.push(root)
  return new BidWorkspace(root)
}

it('记录只按稳定身份定位，阶段与答案更新仍读取同一个文件', async () => {
  const project = await workspace()
  const record = await readBidInputRecovery(project, binding, 3)
  record.phase = 'answered'
  record.attempts = 1
  record.answer = { id: 'input-question', selected: [], custom: '保留原验收范围' }
  await writeBidInputRecovery(project, record)
  const reopened = await readBidInputRecovery(new BidWorkspace(project.root), binding, 20)
  expect(reopened).toMatchObject({ phase: 'answered', attempts: 1, budget: 3, answer: record.answer })
  reopened.phase = 'applied'
  await writeBidInputRecovery(project, reopened)
  expect(await readdir(join(project.projectRoot, 'runs/input-work'))).toHaveLength(1)
  expect(await readBidInputRecovery(project, binding, 20)).toMatchObject({ phase: 'applied', attempts: 1, budget: 3 })
})

it('重启或增配不扩大原预算，减配后持久保存更小预算', async () => {
  const project = await workspace()
  const record = await readBidInputRecovery(project, binding, 4)
  record.attempts = 2
  await writeBidInputRecovery(project, record)
  const shrunk = await readBidInputRecovery(project, binding, 2)
  expect(shrunk).toMatchObject({ attempts: 2, budget: 2 })
  await writeBidInputRecovery(project, shrunk)
  expect(await readBidInputRecovery(new BidWorkspace(project.root), binding, 20)).toMatchObject({ attempts: 2, budget: 2 })
})

it('磁盘记录的 Work 或问题身份被更改时拒绝读取', async () => {
  const project = await workspace()
  await writeBidInputRecovery(project, await readBidInputRecovery(project, binding, 3))
  const directory = join(project.projectRoot, 'runs/input-work')
  const path = join(directory, (await readdir(directory))[0]!)
  const record = JSON.parse(await readFile(path, 'utf8')) as { question_key: string }
  record.question_key = 'other-question'
  await writeFile(path, JSON.stringify(record))
  await expect(readBidInputRecovery(project, binding, 3)).rejects.toMatchObject({ code: 'BID_INPUT_IDENTITY_MISMATCH' })
})

it('权限、版本、身份和未知故障不能按资源暂态重试', () => {
  for (const code of ['EACCES', 'BID_RESUME_NOT_ALLOWED', 'BID_INPUT_IDENTITY_MISMATCH', 'unknown']) {
    expect(retryableBidInputFailure(Object.assign(new Error(code), { code }))).toBe(false)
  }
  expect(retryableBidInputFailure(Object.assign(new Error('写盘暂态'), { code: 'EIO' }))).toBe(true)
})

it('应用身份必须绑定当前执行次数，已接纳记录必须包含 Run 身份', async () => {
  const project = await workspace()
  const record = await readBidInputRecovery(project, binding, 3)
  await expect(writeBidInputRecovery(project, { ...record, attempts: 1,
    application: { id: 'b'.repeat(64), attempt: 2 } })).rejects.toThrow('应用标识必须绑定当前持久执行次数')
  await expect(writeBidInputRecovery(project, { ...record, phase: 'accepted' })).rejects.toThrow('已接纳状态必须保存实际 Run 身份')
})
