import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BidWorkspace, parseEvidenceMapArtifact, validateEvidenceMapping, type StageArtifact } from '@deepseek-ai/dsh-bid'

const artifacts: StageArtifact[] = [{ stage: 'evidence_mapping', type: 'evidence_map', path: 'analysis/evidence-map.json' }]

async function fixture() {
  const workspace = new BidWorkspace(await mkdtemp(join(tmpdir(), 'dsh-evidence-map-')), 'session')
  const [tender, reference] = await workspace.import([
    { name: 'tender.md', role: 'tender', bytes: new TextEncoder().encode('提供项目实施方案。技术架构合理得 5 分。') },
    { name: 'history.md', role: 'reference', bytes: new TextEncoder().encode('项目实施包括准备、部署、联调测试和验收。') },
  ])
  if (tender === undefined || reference === undefined || reference.chunksPath === null || reference.absoluteChunkIndexPath === null) throw new Error('fixture corpus missing')
  const index = JSON.parse(await readFile(reference.absoluteChunkIndexPath, 'utf8')) as { chunks: Array<{ path: string }> }
  const chunk = `${reference.chunksPath}/${index.chunks[0]!.path}`
  const lines = (await readFile(join(workspace.sessionRoot, chunk), 'utf8')).split('\n').length
  await mkdir(join(workspace.sessionRoot, 'analysis'), { recursive: true })
  await writeFile(join(workspace.sessionRoot, 'analysis/requirements.json'), JSON.stringify({ schema_version: 1, requirements: [{ id: 'R-1', category: '技术', raw_text: '提供项目实施方案', normalized_requirement: '提供项目实施方案', mandatory: true, source_refs: [{ file_id: tender.id, chunk: 'x', line_start: 1, line_end: 1 }] }] }))
  await writeFile(join(workspace.sessionRoot, 'analysis/scoring.json'), JSON.stringify({ schema_version: 1, scoring_items: [{ id: 'S-1', parent: null, group: '技术', title: '架构', raw_text: '技术架构合理得 5 分', criterion: '架构合理', score: 5, score_range: null, must_answer: true, source_refs: [{ file_id: tender.id, chunk: 'x', line_start: 1, line_end: 1 }] }] }))
  return { workspace, reference, chunk, lines }
}

describe('evidence-map Artifact schema', () => {
  it('rejects invalid material usage and missing mapping identifiers', () => {
    expect(() => parseEvidenceMapArtifact({
      schema_version: 1, requirement_mappings: [{ materials: [], missing_topics: [] }], scoring_mappings: [],
    })).toThrow()
    expect(() => parseEvidenceMapArtifact({
      schema_version: 1,
      requirement_mappings: [{ requirement_id: 'R', materials: [], missing_topics: [] }],
      scoring_mappings: [],
    })).toThrow()
    expect(() => parseEvidenceMapArtifact({
      schema_version: 1,
      requirement_mappings: [],
      scoring_mappings: [{
        scoring_id: 'S',
        materials: [{ file_id: 'f', chunk: 'c', line_start: 1, line_end: 1, usage: 'score', summary: 'x' }],
        missing_topics: [],
      }],
    })).toThrow()
  })
})

describe('evidence-mapping validator', () => {
  it('accepts complete mappings, including a missing technical topic', async () => {
    const value = await fixture()
    await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify({ schema_version: 1, requirement_mappings: [{ requirement_id: 'R-1', materials: [{ file_id: value.reference.id, chunk: value.chunk, line_start: 1, line_end: value.lines, usage: 'adapt', summary: '历史项目实施流程。' }], missing_topics: [] }], scoring_mappings: [{ scoring_id: 'S-1', materials: [], missing_topics: ['缺少本项目架构设计。'] }] }))
    await expect(validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)).resolves.toEqual({ ok: true })
  })

  it('rejects omitted ids, unknown files, and line ranges outside a chunk', async () => {
    const value = await fixture()
    await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify({ schema_version: 1, requirement_mappings: [{ requirement_id: 'unknown', materials: [{ file_id: 'missing', chunk: value.chunk, line_start: 1, line_end: value.lines + 1, usage: 'adapt', summary: 'x' }], missing_topics: [] }], scoring_mappings: [] }))
    const result = await validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['EVIDENCE_MAPPING_REQUIREMENT_UNKNOWN', 'EVIDENCE_MAPPING_REQUIREMENT_MISSING', 'EVIDENCE_MAPPING_SCORING_MISSING', 'EVIDENCE_MAPPING_SOURCE_FILE_UNKNOWN']))
  })

  it('rejects material from a tender file', async () => {
    const value = await fixture()
    const manifest = await value.workspace.readManifest()
    const tender = manifest.files.find(file => file.role === 'tender')
    if (tender === undefined || tender.chunksPath === null || tender.chunkIndexPath === null) throw new Error('fixture tender missing')
    const index = JSON.parse(await readFile(join(value.workspace.sessionRoot, tender.chunkIndexPath), 'utf8')) as { chunks: Array<{ path: string }> }
    const chunk = `${tender.chunksPath}/${index.chunks[0]!.path}`
    await writeFile(join(value.workspace.sessionRoot, 'analysis/evidence-map.json'), JSON.stringify({
      schema_version: 1,
      requirement_mappings: [{ requirement_id: 'R-1', materials: [{ file_id: tender.id, chunk, line_start: 1, line_end: 1, usage: 'reference', summary: '招标原文。' }], missing_topics: [] }],
      scoring_mappings: [{ scoring_id: 'S-1', materials: [], missing_topics: ['缺少技术资料。'] }],
    }))
    const result = await validateEvidenceMapping(value.workspace, 'evidence_mapping', artifacts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map(issue => issue.code)).toContain('EVIDENCE_MAPPING_SOURCE_FILE_NOT_REFERENCE')
  })
})
