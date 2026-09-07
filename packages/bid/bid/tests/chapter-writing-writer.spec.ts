import { mkdir, mkdtemp, writeFile, unlink, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { BidWorkspace } from '@deepseek-ai/dsh-bid'
import { parseChapterCandidate, parseChapterMetadata } from '../src/chapter-writing-artifacts.ts'
import { appendChapterWebReferences, bindChapterWriterInput, createChapterWriterReferences, projectChapterWriterCandidate, readChapterWebSource, renderChapterWriterReferences } from '../src/chapter-writing-writer.ts'
import { buildChapterReviewEvidence } from '../src/chapter-writing-review.ts'
import { webEvidenceContentSha256, webEvidenceSourceId } from '../src/web-evidence-source-artifacts.ts'
import type { WebEvidenceSnapshot } from '../src/web-evidence-snapshot.ts'
import { emptyChapterContext, outlineFixture } from './fixtures/chapter-writing-inputs.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, readFile: vi.fn(original.readFile) }
})

async function ledger(workspace: BidWorkspace, snapshots: WebEvidenceSnapshot[]) {
  await writeFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), JSON.stringify({
    schema_version: 2, stage: 'evidence_mapping', sources: snapshots.map(value => value.source),
  }))
}

function snapshot(content = '公共技术资料原文', url = 'https://official.example/technical'): WebEvidenceSnapshot {
  const hash = webEvidenceContentSha256(content)
  const id = webEvidenceSourceId(url, hash)
  return { content, source: { source_id: id, requested_url: url, final_url: url, snapshot_path: `analysis/web-sources/${id}.md`, status_code: 200, truncated: false, fetched_at: '2026-09-01T00:00:00Z', content_sha256: hash } }
}

async function fixture() {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-s5-writer-input-')))
  await workspace.import([
    { name: 'company.md', role: 'reference', bytes: new TextEncoder().encode('# 适用企业事实\n\n本地企业资料原文，包含实际资质与实施流程。') },
    { name: 'old-bid.md', role: 'reference_bid', bytes: new TextEncoder().encode('# 历史方案\n\n历史方案技术资料原文，不证明本项目企业事实。') },
    { name: 'framework.md', role: 'outline_framework', bytes: new TextEncoder().encode('# 框架\n\n用户框架不是事实依据。') },
    { name: 'tender.md', role: 'tender', bytes: new TextEncoder().encode('# 招标\n\n整本 tender 不得注入 Writer 或 Reviewer。') },
  ])
  const manifest = await workspace.readManifest()
  const context = emptyChapterContext(outlineFixture().sections[1]!)
  context.availableLocalCorpus = manifest.files.filter(file => file.role !== 'tender').map(file => ({ file_id: String(file.id), name: file.originalName, role: file.role as 'reference' | 'reference_bid' | 'outline_framework', chunks_path: join(workspace.projectRoot, file.chunksPath!), chunk_index_path: join(workspace.projectRoot, file.chunkIndexPath!) }))
  context.relatedMaterials = [{ source_kind: 'reference', file_id: String(manifest.files[0]!.id), chunk: 'chunk_0001', usage: 'reference', summary: '企业资料' }]
  const refs = createChapterWriterReferences(context)
  const web = snapshot()
  await mkdir(join(workspace.projectRoot, 'analysis/web-sources'), { recursive: true })
  await writeFile(join(workspace.projectRoot, web.source.snapshot_path), web.content)
  await ledger(workspace, [web])
  await appendChapterWebReferences(workspace, refs, [web.source])
  const bind = (metadata: unknown, snapshots: readonly WebEvidenceSnapshot[] = []) => bindChapterWriterInput(workspace, manifest, context, refs, { markdown: `# ${context.section.title}\n\n完整正文与具体技术方案。`, metadata }, snapshots)
  return { workspace, manifest, context, refs, web, bind }
}

describe('S5 Writer 短引用与语义输入', () => {
  afterEach(() => vi.mocked(readFile).mockReset())

  it('共同提交路径拒绝新增 ATX 和 Setext 标题，允许修正为叶节正文', async () => {
    const { workspace, manifest, context, refs } = await fixture()
    for (const heading of ['## 馆际互借', '馆际互借\n---']) {
      await expect(bindChapterWriterInput(workspace, manifest, context, refs, {
        markdown: `# ${context.section.title}\n\n${heading}\n\n借阅方式。`, metadata: {},
      }, [])).rejects.toThrow('不能新增目录标题“馆际互借”')
    }
    await expect(bindChapterWriterInput(workspace, manifest, context, refs, {
      markdown: `# ${context.section.title}\n\n本节根据项目需求说明适用范围。\n\n- 核实任务目标。`, metadata: {},
    }, [])).resolves.toMatchObject({ section_id: context.section.id })
  })

  it('候选池隔离缺失、Hash 和不安全路径，不给坏来源新 W，并显示中文原因', async () => {
    const { workspace, refs, context, web } = await fixture()
    const missing = snapshot('缺失正文')
    const corrupt = snapshot('损坏正文')
    const unsafe = snapshot('越界正文')
    unsafe.source.snapshot_path = '../outside.md'
    await writeFile(join(workspace.projectRoot, corrupt.source.snapshot_path), '错误内容')
    await appendChapterWebReferences(workspace, refs, [missing.source, corrupt.source, unsafe.source, web.source])
    expect([...refs.web.keys()]).toEqual(['W1'])
    expect(refs.unavailable.get(missing.source.source_id)).toContain('ENOENT')
    expect(refs.unavailable.get(corrupt.source.source_id)).toContain('Hash')
    expect(refs.unavailable.get(unsafe.source.source_id)).toContain('bid-path-traversal')
    const rendered = renderChapterWriterReferences(context, refs)
    expect(rendered).toContain('不可用')
    expect(rendered).not.toContain('unavailable')
    expect(rendered).not.toContain('"web_ref":"W2"')
  })

  it('映射来源缺失或身份错时保留写作要求并明确不可用', async () => {
    const { context, refs, web } = await fixture()
    const missing = snapshot('未登记正文')
    context.webMaterials = [
      { source_id: missing.source.source_id, snapshot_path: missing.source.snapshot_path, usage: 'reference', summary: '必须解释容灾机制', supports: '恢复时间要求' },
      { source_id: web.source.source_id, snapshot_path: missing.source.snapshot_path, usage: 'background', summary: '必须说明数据保护', supports: '加密要求' },
    ]
    const rendered = renderChapterWriterReferences(context, refs)
    for (const value of ['不可用', '账本', '身份不匹配', '必须解释容灾机制', '恢复时间要求', '必须说明数据保护', '加密要求', '写作要求']) {
      expect(rendered).toContain(value)
    }
  })

  it('已发 W 损坏或移除仍保留，恢复沿用编号，新增来源不重用旧 W', async () => {
    const { workspace, refs, web, bind, context } = await fixture()
    const metadata = { web_materials_used: [{ web_ref: 'W1', usage: 'reference', summary: '依据', supports: '技术' }] }
    const candidate = await bind(metadata)
    await unlink(join(workspace.projectRoot, web.source.snapshot_path))
    await appendChapterWebReferences(workspace, refs, [web.source])
    expect(refs.web.get('W1')?.source_id).toBe(web.source.source_id)
    expect(refs.unavailable.get(web.source.source_id)).toContain('ENOENT')
    await expect(bind(metadata)).rejects.toBeInstanceOf(ToolArgsError)
    expect(renderChapterWriterReferences(context, refs)).not.toContain('"read_path"')
    const second = snapshot('另一份正文')
    await writeFile(join(workspace.projectRoot, second.source.snapshot_path), second.content)
    await ledger(workspace, [second])
    await appendChapterWebReferences(workspace, refs, [second.source])
    expect([...refs.web.keys()]).toEqual(['W1', 'W2'])
    expect(refs.unavailable.get(web.source.source_id)).toContain('账本')
    const { additional_web_materials: _additional, ...accepted } = candidate.metadata
    expect(JSON.stringify(projectChapterWriterCandidate({ ...candidate, metadata: accepted }, refs))).toContain('W1')
    await writeFile(join(workspace.projectRoot, web.source.snapshot_path), web.content)
    await expect(bind(metadata)).rejects.toBeInstanceOf(ToolArgsError)
    await ledger(workspace, [web, second])
    await appendChapterWebReferences(workspace, refs, [second.source, web.source])
    expect(refs.unavailable.size).toBe(0)
    expect(refs.web.get('W1')?.source_id).toBe(web.source.source_id)
    await expect(bind(metadata)).resolves.toBeDefined()
  })

  it('bind 独立拒绝已从账本删除的 W；账本读取和解析错误传播', async () => {
    const { workspace, bind } = await fixture()
    const metadata = { web_materials_used: [{ web_ref: 'W1', usage: 'reference', summary: '依据', supports: '技术' }] }
    await ledger(workspace, [])
    await expect(bind(metadata)).rejects.toBeInstanceOf(ToolArgsError)
    await writeFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), '{')
    await expect(bind(metadata)).rejects.toBeInstanceOf(SyntaxError)
    await writeFile(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'), '{}')
    await expect(bind(metadata)).rejects.toMatchObject({ name: 'ZodError' })
    await unlink(join(workspace.projectRoot, 'analysis/web-evidence-sources.json'))
    await expect(bind(metadata)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('相同 source_id 的账本身份变化不能改写已发 W', async () => {
    const { workspace, refs, web, bind } = await fixture()
    const changed = { content: '替换后的正文', source: { ...web.source, content_sha256: webEvidenceContentSha256('替换后的正文') } }
    await writeFile(join(workspace.projectRoot, changed.source.snapshot_path), changed.content)
    await ledger(workspace, [changed])
    await appendChapterWebReferences(workspace, refs, [changed.source])
    expect(refs.web.get('W1')?.content_sha256).toBe(web.source.content_sha256)
    expect(refs.unavailable.get(web.source.source_id)).toContain('身份不匹配')
    await expect(bind({ web_materials_used: [{ web_ref: 'W1', usage: 'reference', summary: '依据', supports: '技术' }] })).rejects.toBeInstanceOf(ToolArgsError)
  })

  it.each(['../outside.md', '/outside.md', 'C:/outside.md'])('读取拒绝不安全路径 %s', async (snapshot_path) => {
    const { workspace, web } = await fixture()
    await expect(readChapterWebSource(workspace, { ...web.source, snapshot_path })).rejects.toBeInstanceOf(ToolArgsError)
  })

  it('目录链接不能作为 Snapshot 读取路径', async () => {
    const { workspace, web, refs } = await fixture()
    const linked = join(workspace.projectRoot, 'linked-snapshots')
    await symlink(join(workspace.projectRoot, 'analysis/web-sources'), linked, process.platform === 'win32' ? 'junction' : 'dir')
    const source = { ...web.source, snapshot_path: `linked-snapshots/${web.source.source_id}.md` }
    await expect(readChapterWebSource(workspace, source)).rejects.toBeInstanceOf(ToolArgsError)
    await appendChapterWebReferences(workspace, refs, [source])
    expect(refs.unavailable.get(source.source_id)).toContain('symbolic-link')
  })

  it.each([
    Object.assign(new Error('已取消'), { name: 'AbortError', code: 'ABORT_ERR' }),
    Object.assign(new Error('Host 故障'), { code: 'ENOSPC' }),
    new Error('未知读取故障'),
    new ToolArgsError(['非单来源错误']),
  ])('候选池不吞取消或基础设施错误：%s', async (failure) => {
    const { workspace, refs, web } = await fixture()
    vi.mocked(readFile).mockRejectedValueOnce(failure)
    await expect(appendChapterWebReferences(workspace, refs, [web.source])).rejects.toBe(failure)
  })

  it('省略空数组和 handoff 后补齐语义字段，三份身份与 Blueprint 索引由 Host 注入', async () => {
    const { bind, context } = await fixture()
    const candidate = await bind({})
    expect(parseChapterCandidate(candidate)).toEqual(candidate)
    const { additional_web_materials, ...metadata } = candidate.metadata
    expect(additional_web_materials).toEqual([])
    expect(parseChapterMetadata(metadata)).toMatchObject({
      section_id: context.section.id, covered_must_answer: context.section.must_answer,
      covered_scoring_response_point_ids: context.section.scoring_response_point_ids,
      covered_scoring_response_points: context.section.scoring_response_points,
      local_materials_used: [], web_materials_used: [], unresolved_topics: [],
      handoff: { section_id: context.section.id, decisions: [], terminology: [], unresolved_topics: [] },
    })
    for (const invalid of [{ local_materials_used: null }, { unresolved_topics: 7 }, { handoff: { decisions: '错误类型' } }, { handoff: null }, { section_id: context.section.id }, { covered_must_answer: [] }]) {
      await expect(bind(invalid)).rejects.toThrow('invalid arguments')
    }
  })

  it('M 和 F 按真实 chunk 身份去重；语义冲突必须明确拒绝', async () => {
    const { bind, refs } = await fixture()
    expect([...refs.files.values()].map(file => file.role)).toEqual(['reference', 'reference_bid'])
    const semantics = { usage: 'reference', summary: '资料依据' }
    const mapped = { material_ref: 'M1', ...semantics }
    const file = { file_ref: 'F1', chunk: 'chunk_0001', ...semantics }
    const candidate = await bind({ local_materials_used: [mapped, file] })
    expect(candidate.metadata.local_materials_used).toHaveLength(1)
    await expect(bind({ local_materials_used: [mapped, { ...file, usage: 'background' }] })).rejects.toThrow('冲突')
    await expect(bind({ local_materials_used: [{ ...mapped, ...file }] })).rejects.toThrow('invalid arguments')
    await expect(bind({ local_materials_used: [{ ...file, usage: 'adapt' }] })).rejects.toThrow('usage')
    expect((await bind({ local_materials_used: [{ ...file, file_ref: 'F2', usage: 'adapt' }] })).metadata.local_materials_used[0]?.source_kind).toBe('reference_bid')
  })

  it.each([
    { material_ref: 'M999', usage: 'reference', summary: '资料依据' },
    { file_ref: 'F3', chunk: 'chunk_0001', usage: 'reference', summary: '框架伪装成证据' },
    { file_ref: 'F1', chunk: 'chunk_9999', usage: 'reference', summary: '无效 chunk' },
    { source_kind: 'reference', file_id: 'framework', chunk: 'chunk_0001', usage: 'reference', summary: '伪造身份' },
  ])('拒绝未知或伪造本地引用 %j', async (invalid) => {
    const { bind } = await fixture()
    await expect(bind({ local_materials_used: [invalid] })).rejects.toThrow()
    expect((await bind({ local_materials_used: [{ file_ref: 'F1', chunk: 'chunk_0001', usage: 'reference', summary: '已修正' }] })).metadata.local_materials_used).toHaveLength(1)
  })

  it('已有 W 无需联网，新 URL 必须有当前成功 fetch；引用与 Snapshot Hash 均验证', async () => {
    const { bind, web, workspace } = await fixture()
    const semantics = { usage: 'reference', summary: '公开资料', supports: '技术方法' }
    expect((await bind({ web_materials_used: [{ web_ref: 'W1', ...semantics }] })).metadata.web_materials_used[0]?.source_id).toBe(web.source.source_id)
    await expect(bind({ web_materials_used: [{ web_ref: 'W999', ...semantics }] })).rejects.toThrow('W999')
    await expect(bind({ additional_web_materials: [{ url: web.source.final_url, ...semantics }] })).rejects.toThrow('当前 Writer')
    const fetched = await bind({ additional_web_materials: [{ url: web.source.final_url, ...semantics }] }, [web])
    expect(fetched.metadata.additional_web_materials).toHaveLength(1)
    await writeFile(join(workspace.projectRoot, web.source.snapshot_path), '篡改正文')
    await expect(bind({ web_materials_used: [{ web_ref: 'W1', ...semantics }] })).rejects.toThrow('Hash')
  })

  it('修复只追加 W 编号，候选投影不带内部身份或任务覆盖索引', async () => {
    const { bind, web, workspace, refs } = await fixture()
    const second = snapshot('新增公开技术资料', 'https://official.example/new')
    await writeFile(join(workspace.projectRoot, second.source.snapshot_path), second.content)
    await ledger(workspace, [web, second])
    await appendChapterWebReferences(workspace, refs, [second.source, web.source])
    expect([...refs.web].map(([ref, source]) => [ref, source.source_id])).toEqual([['W1', web.source.source_id], ['W2', second.source.source_id]])
    const candidate = await bind({ local_materials_used: [{ file_ref: 'F1', chunk: 'chunk_0001', usage: 'reference', summary: '依据' }], web_materials_used: [{ web_ref: 'W2', usage: 'reference', summary: '依据', supports: '技术方法' }] })
    const { additional_web_materials: _additional, ...metadata } = candidate.metadata
    const projected = JSON.stringify(projectChapterWriterCandidate({ ...candidate, metadata }, refs))
    expect(projected).toContain('M1')
    expect(projected).toContain('W2')
    for (const key of ['section_id', 'covered_', 'source_id', 'file_id', 'snapshot_path']) expect(projected).not.toContain(key)
  })

  it('Evidence Pack 包含新增 F chunk 与新增 Web 原文，保持来源证明范围', async () => {
    const { workspace, manifest, context, refs, bind } = await fixture()
    const newWeb = snapshot('新 fetch 的实际技术正文', 'https://official.example/new')
    await writeFile(join(workspace.projectRoot, newWeb.source.snapshot_path), newWeb.content)
    await ledger(workspace, [newWeb])
    await appendChapterWebReferences(workspace, refs, [newWeb.source])
    const candidate = await bind({ local_materials_used: [{ file_ref: 'F2', chunk: 'chunk_0001', usage: 'adapt', summary: '仅为 summary' }], web_materials_used: [{ web_ref: 'W2', usage: 'reference', summary: '仅为 summary', supports: '技术' }] })
    const { additional_web_materials: _additional, ...metadata } = candidate.metadata
    const pack = await buildChapterReviewEvidence(workspace, manifest, context, { ...candidate, metadata }, [newWeb.source], [{ section_id: 'SEC-2', handoff: metadata.handoff }])
    expect(pack.find(item => item.category === 'reference_bid')?.content).toContain('历史方案技术资料原文')
    expect(pack.find(item => item.category === 'web')?.content).toBe(newWeb.content)
    expect(pack.find(item => item.category === 'web')?.locator).toBe(newWeb.source.snapshot_path)
    expect(pack.find(item => item.category === 'handoff')?.allowed_claim_kinds).toEqual([])
    expect(JSON.stringify(pack)).not.toContain('整本 tender 不得注入')
    expect(pack.map(item => item.source_ref)).toEqual(pack.map((_, index) => `E${index + 1}`))
  })
})
