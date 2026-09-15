import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Document, Packer, Paragraph } from 'docx'
import { afterEach, describe, expect, it } from 'vitest'
import { flowchartPlaceholder, normalizeFlowchartInputs, type FlowchartDraft } from '../src/flowchart.ts'
import { createNativeVisioExport } from '../src/native-visio.ts'

const execFileAsync = promisify(execFile)
const officeAvailable = process.platform === 'win32' && spawnSync('powershell.exe', [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
  "$ErrorActionPreference='Stop'; try { $v=New-Object -ComObject 'Visio.Application' -ErrorAction Stop; if ($null -eq $v) { throw 'Visio null' }; $v.Quit(); $w=New-Object -ComObject 'Word.Application' -ErrorAction Stop; if ($null -eq $w) { throw 'Word null' }; $w.Quit(); exit 0 } catch { exit 1 }",
], { windowsHide: true }).status === 0
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function encoded(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

function psValue(value: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded(value)}'))`
}

async function runPowerShell(script: string): Promise<string> {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  return stdout
}

async function inspectVisio(path: string): Promise<{
  pages: number
  shapes: number
  nodes: number
  connectors: number
  pageWidth: number
  pageHeight: number
  texts: string[]
}> {
  const output = await runPowerShell(`$app = $null
$document = $null
try {
  $app = New-Object -ComObject 'Visio.Application'
  $document = $app.Documents.Open(${psValue(path)}, $false, $true)
  $page = $document.Pages.Item(1)
  $texts = @()
  $nodes = 0
  $connectors = 0
  foreach ($shape in $page.Shapes) {
    $texts += [string]$shape.Text
    if ([string]$shape.NameU -like 'N*') { $nodes++ }
    if ([string]$shape.NameU -like 'E*') { $connectors++ }
  }
  [ordered]@{ pages = [int]$document.Pages.Count; shapes = [int]$page.Shapes.Count; nodes = $nodes; connectors = $connectors; pageWidth = [double]$page.PageSheet.CellsU('PageWidth').ResultIU; pageHeight = [double]$page.PageSheet.CellsU('PageHeight').ResultIU; texts = @($texts) } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $document) { $document.Close() }
  if ($null -ne $app) { $app.Quit() }
}`)
  return JSON.parse(output.trim()) as {
    pages: number
    shapes: number
    nodes: number
    connectors: number
    pageWidth: number
    pageHeight: number
    texts: string[]
  }
}

async function inspectWord(path: string): Promise<{ inlineShapes: number; visioObjects: number; progIds: string[]; text: string; maxWidth: number; availableWidth: number }> {
  const output = await runPowerShell(`$word = $null
$document = $null
try {
  $word = New-Object -ComObject 'Word.Application'
  $document = $word.Documents.Open(${psValue(path)}, $false, $true)
  $inlineShapes = @($document.InlineShapes)
  $progIds = @()
  $visioObjects = 0
  $maxWidth = 0.0
  foreach ($shape in $inlineShapes) {
    if ([double]$shape.Width -gt $maxWidth) { $maxWidth = [double]$shape.Width }
    try {
      $progId = [string]$shape.OLEFormat.ProgID
      if ($progId -like 'Visio*') { $visioObjects++; $progIds += $progId }
    } catch {
      # 非 OLE InlineShape 不公开 OLEFormat。
    }
  }
  $section = $document.Sections.Item(1)
  $availableWidth = [double]$section.PageSetup.PageWidth - [double]$section.PageSetup.LeftMargin - [double]$section.PageSetup.RightMargin
  [ordered]@{ inlineShapes = $inlineShapes.Count; visioObjects = $visioObjects; progIds = @($progIds); text = [string]$document.Content.Text; maxWidth = $maxWidth; availableWidth = $availableWidth } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $document) { $document.Close() }
  if ($null -ne $word) { $word.Quit() }
}`)
  return JSON.parse(output.trim()) as { inlineShapes: number; visioObjects: number; progIds: string[]; text: string; maxWidth: number; availableWidth: number }
}

async function activateEditAndMove(path: string): Promise<{ moved: boolean; text: string }> {
  const output = await runPowerShell(`$word = $null
$document = $null
try {
  $word = New-Object -ComObject 'Word.Application'
  $document = $word.Documents.Open(${psValue(path)}, $false, $false)
  $inline = $document.InlineShapes.Item(1)
  $inline.OLEFormat.Activate()
  $visio = $inline.OLEFormat.Object
  $page = $visio.Pages.Item(1)
  $node = $page.Shapes.ItemU('N2')
  $connector = $page.Shapes.ItemU('E1')
  $before = [double]$connector.CellsU('EndX').ResultIU
  $node.Text = '质量复核'
  $node.CellsU('PinX').ResultIU = [double]$node.CellsU('PinX').ResultIU + 1.0
  $after = [double]$connector.CellsU('EndX').ResultIU
  $visio.Save()
  $document.Save()
  [ordered]@{ moved = ($after -ne $before); text = [string]$page.Shapes.ItemU('N2').Text } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $document) { $document.Close() }
  if ($null -ne $word) { $word.Quit() }
}`)
  return JSON.parse(output.trim()) as { moved: boolean; text: string }
}

const draft: FlowchartDraft = {
  key: 'quality-control-flow', title: '质量检查闭环', direction: 'TB',
  nodes: [
    { key: 'start', type: 'start', text: '开始' }, { key: 'check', type: 'decision', text: '质量检查' },
    { key: 'submit', type: 'end', text: '成果提交' },
  ],
  edges: [{ from: 'start', to: 'check' }, { from: 'check', to: 'submit', label: '通过' }, { from: 'check', to: 'start', label: '不通过' }],
}

describe.skipIf(!officeAvailable)('Windows Word + Visio COM integration', () => {
  it('生成单页原生 VSDX，并嵌入可编辑且按版心缩放的 Word OLE', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-visio-integration-'))
    temporaryRoots.push(root)
    const spec = normalizeFlowchartInputs('INTEGRATION', [draft])[0]!
    const vsdxPath = join(root, `${spec.id}.vsdx`)
    const docxPath = join(root, 'bid.docx')
    const office = createNativeVisioExport()
    await office.visio.createDiagram(spec, vsdxPath)
    const visio = await inspectVisio(vsdxPath)
    expect(visio.pages).toBe(1)
    expect(visio.pageWidth).toBeLessThan(8.5)
    expect(visio.pageHeight).toBeLessThan(11)
    expect(visio.shapes).toBeGreaterThanOrEqual(spec.nodes.length + spec.edges.length)
    expect(visio.nodes).toBe(spec.nodes.length)
    expect(visio.connectors).toBe(spec.edges.length)
    expect(visio.texts).toEqual(expect.arrayContaining(['开始', '质量检查', '成果提交', '通过', '不通过']))

    const document = new Document({ sections: [{ children: [
      new Paragraph({ text: '前文' }), new Paragraph({ text: flowchartPlaceholder(spec) }), new Paragraph({ text: '后文' }),
    ] }] })
    await writeFile(docxPath, await Packer.toBuffer(document))
    await office.word.embed(docxPath, [{ placeholder: flowchartPlaceholder(spec), visioPath: vsdxPath }])
    const embedded = await inspectWord(docxPath)
    expect(embedded.visioObjects).toBe(1)
    expect(embedded.progIds).toHaveLength(1)
    expect(embedded.maxWidth).toBeLessThanOrEqual(embedded.availableWidth + 1)
    expect(embedded.text.indexOf('前文')).toBeLessThan(embedded.text.indexOf('后文'))

    await unlink(vsdxPath)
    await expect(inspectWord(docxPath)).resolves.toMatchObject({ visioObjects: 1 })
    await expect(activateEditAndMove(docxPath)).resolves.toEqual({ moved: true, text: '质量复核' })
    await expect(inspectWord(docxPath)).resolves.toMatchObject({ visioObjects: 1 })
  })
})
