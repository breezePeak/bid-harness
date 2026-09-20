/** Windows Office bridge for native Visio drawings and embedded Word OLE objects. */
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { layoutFlowchart, validateFlowchartSpec, type FlowchartSpec } from './flowchart.ts'
import { createNativeWordFinalizer, type WordDocumentFinalizer } from './native-word.ts'

const execFileAsync = promisify(execFile)
/** Stable error code returned when Visio COM cannot be activated. */
export const VISIO_RUNTIME_UNAVAILABLE = 'VISIO_RUNTIME_UNAVAILABLE'
/** Stable error code returned when Word COM cannot be activated. */
export const WORD_RUNTIME_UNAVAILABLE = 'WORD_RUNTIME_UNAVAILABLE'

/** Result of one native Visio drawing creation. */
export interface VisioDiagramResult {
  readonly path: string
  readonly nodeCount: number
  readonly connectorCount: number
}

/** Native Visio capability used by the formal S6 export. */
export interface VisioBackend {
  isAvailable(): Promise<boolean>
  createDiagram(spec: FlowchartSpec, outputPath: string): Promise<VisioDiagramResult>
}

/** Native Word capability used to embed and inspect Visio OLE objects. */
export interface WordVisioEmbedder {
  isAvailable(): Promise<boolean>
  embed(docxPath: string, replacements: readonly { placeholder: string; visioPath: string }[]): Promise<void>
  countVisioObjects(docxPath: string): Promise<number>
}

/** Paired Visio and Word capabilities used by one S6 export. */
export interface NativeVisioExport {
  readonly visio: VisioBackend
  readonly word: WordVisioEmbedder
  readonly finalizer?: WordDocumentFinalizer
}

export { flowchartPlaceholder } from './flowchart.ts'

/** Extract the structured blocks collected for a formal DOCX export.
 * @param markdown Collected Markdown snapshot.
 * @returns Validated flowchart specifications in document order.
 */
export function extractFlowchartSpecs(markdown: string): FlowchartSpec[] {
  const specs: FlowchartSpec[] = []
  for (const match of markdown.matchAll(/```flowchart\s*\n([\s\S]*?)\n```/gu)) {
    let spec: FlowchartSpec
    try { spec = JSON.parse(match[1] ?? '') as FlowchartSpec } catch { throw new Error('流程图数据不是有效 JSON。') }
    const issues = validateFlowchartSpec(spec)
    if (issues.length > 0) throw new Error(`流程图无法导出：${issues.join('；')}`)
    specs.push(spec)
  }
  return specs
}

function encoded(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

async function runPowerShell(script: string): Promise<string> {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  return stdout
}

function decodeScriptValue(expression: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded(expression)}'))`
}

function runtimeScript(progId: string): string {
  return `$app = $null
try {
  $app = New-Object -ComObject '${progId}'
  if ($null -eq $app) { throw 'COM unavailable' }
} finally {
  if ($null -ne $app) { $app.Quit() }
}`
}

function createVisioScript(spec: FlowchartSpec, outputPath: string): string {
  const layout = layoutFlowchart(spec)
  const layoutJson = JSON.stringify({
    width: layout.width,
    height: layout.height,
    nodes: [...layout.positions].map(([id, position]) => ({ id, ...position })),
  })
  return `$ErrorActionPreference = 'Stop'
$spec = (${decodeScriptValue(JSON.stringify(spec))}) | ConvertFrom-Json
$layout = (${decodeScriptValue(layoutJson)}) | ConvertFrom-Json
$output = ${decodeScriptValue(outputPath)}
$app = $null
$document = $null
try {
  $app = New-Object -ComObject 'Visio.Application'
  $app.Visible = $false
  $document = $app.Documents.Add('')
  $page = $document.Pages.Item(1)
  $scale = 96.0
  $pageWidth = [Math]::Max(1.0, ([double]$layout.width / $scale) + 1.0)
  $pageHeight = [Math]::Max(1.0, ([double]$layout.height / $scale) + 1.0)
  $page.PageSheet.CellsU('PageWidth').FormulaU = "$pageWidth in"
  $page.PageSheet.CellsU('PageHeight').FormulaU = "$pageHeight in"
  $positions = @{}
  foreach ($item in $layout.nodes) { $positions[[string]$item.id] = $item }
  $shapes = @{}
  foreach ($node in $spec.nodes) {
    $position = $positions[[string]$node.id]
    $x1 = 0.5 + ([double]$position.x / $scale)
    $x2 = $x1 + ([double]$position.width / $scale)
    $y2 = $pageHeight - 0.5 - ([double]$position.y / $scale)
    $y1 = $y2 - ([double]$position.height / $scale)
    switch ([string]$node.type) {
      'start' { $shape = $page.DrawOval($x1, $y1, $x2, $y2) }
      'end' { $shape = $page.DrawOval($x1, $y1, $x2, $y2) }
      'decision' {
        $points = New-Object 'System.Double[]' 10
        $points[0] = ($x1 + $x2) / 2; $points[1] = $y2
        $points[2] = $x2; $points[3] = ($y1 + $y2) / 2
        $points[4] = ($x1 + $x2) / 2; $points[5] = $y1
        $points[6] = $x1; $points[7] = ($y1 + $y2) / 2
        $points[8] = $points[0]; $points[9] = $points[1]
        $shape = $page.DrawPolyline($points, 0)
      }
      'document' {
        $points = New-Object 'System.Double[]' 12
        $fold = [Math]::Min(0.2, ($x2 - $x1) / 4)
        $points[0] = $x1; $points[1] = $y1
        $points[2] = $x1; $points[3] = $y2
        $points[4] = $x2 - $fold; $points[5] = $y2
        $points[6] = $x2; $points[7] = $y2 - $fold
        $points[8] = $x2; $points[9] = $y1
        $points[10] = $points[0]; $points[11] = $points[1]
        $shape = $page.DrawPolyline($points, 0)
      }
      default { $shape = $page.DrawRectangle($x1, $y1, $x2, $y2) }
    }
    $shape.NameU = [string]$node.id
    $shape.Text = [string]$node.text
    $shape.CellsU('LineWeight').FormulaU = '0.02 in'
    if ([string]$node.type -eq 'decision') {
      $shape.CellsU('FillForegnd').FormulaU = 'RGB(255,247,237)'
      $shape.CellsU('LineColor').FormulaU = 'RGB(194,65,12)'
    } elseif ([string]$node.type -eq 'start' -or [string]$node.type -eq 'end') {
      $shape.CellsU('FillForegnd').FormulaU = 'RGB(236,253,245)'
      $shape.CellsU('LineColor').FormulaU = 'RGB(4,120,87)'
    } else {
      $shape.CellsU('FillForegnd').FormulaU = 'RGB(255,255,255)'
      $shape.CellsU('LineColor').FormulaU = 'RGB(51,65,85)'
    }
    $shapes[[string]$node.id] = $shape
  }
  $edgeIndex = 0
  foreach ($edge in $spec.edges) {
    $edgeIndex++
    $from = $shapes[[string]$edge.from]
    $to = $shapes[[string]$edge.to]
    $connector = $page.Drop($app.ConnectorToolDataObject, 0, 0)
    $connector.NameU = "E$edgeIndex"
    $connector.CellsU('BeginX').GlueTo($from.CellsU('PinX'))
    $connector.CellsU('EndX').GlueTo($to.CellsU('PinX'))
    $connector.CellsU('EndArrow').FormulaU = '4'
    if ($null -ne $edge.label -and [string]$edge.label -ne '') { $connector.Text = [string]$edge.label }
  }
  $document.SaveAs($output)
} finally {
  if ($null -ne $document) { $document.Close() }
  if ($null -ne $app) { $app.Quit() }
}`
}

class NativeVisioBackend implements VisioBackend {
  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'win32') return false
    try { await runPowerShell(runtimeScript('Visio.Application')); return true } catch { return false }
  }

  async createDiagram(spec: FlowchartSpec, outputPath: string): Promise<VisioDiagramResult> {
    const issues = validateFlowchartSpec(spec)
    if (issues.length > 0) throw new Error(`流程图无法导出：${issues.join('；')}`)
    if (!(await this.isAvailable())) throw new Error(`${VISIO_RUNTIME_UNAVAILABLE}: 当前环境未检测到 Microsoft Visio。`)
    await mkdir(dirname(outputPath), { recursive: true })
    await runPowerShell(createVisioScript(spec, outputPath))
    return { path: outputPath, nodeCount: spec.nodes.length, connectorCount: spec.edges.length }
  }
}

function embedScript(docxPath: string, replacements: readonly { placeholder: string; visioPath: string }[]): string {
  return `$ErrorActionPreference = 'Stop'
$docx = ${decodeScriptValue(docxPath)}
$replacements = (${decodeScriptValue(JSON.stringify(replacements))}) | ConvertFrom-Json
$word = $null
$document = $null
try {
  $word = New-Object -ComObject 'Word.Application'
  $word.Visible = $false
  $document = $word.Documents.Open($docx, $false, $false)
  foreach ($replacement in $replacements) {
    $range = $document.Content.Duplicate()
    $find = $range.Find
    $find.ClearFormatting()
  $find.Text = [string]$replacement.placeholder
    $find.Forward = $true
    $find.Wrap = 0
    if (-not $find.Execute()) { throw "placeholder not found: $($replacement.placeholder)" }
    $section = $range.Sections.Item(1)
    $range.Text = ''
    $range.Collapse(1)
    $shape = $range.InlineShapes.AddOLEObject($null, [string]$replacement.visioPath, $false, $false, $null, $null, $null, $range)
    $availableWidth = [double]$section.PageSetup.PageWidth - [double]$section.PageSetup.LeftMargin - [double]$section.PageSetup.RightMargin
    $originalWidth = [double]$shape.Width
    $originalHeight = [double]$shape.Height
    if ($originalWidth -gt $availableWidth -and $availableWidth -gt 0) {
      $ratio = $availableWidth / $originalWidth
      $shape.Width = $originalWidth * $ratio
      $shape.Height = $originalHeight * $ratio
    }
  }
  $document.Save()
} finally {
  if ($null -ne $document) { $document.Close() }
  if ($null -ne $word) { $word.Quit() }
}`
}

class NativeWordVisioEmbedder implements WordVisioEmbedder {
  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'win32') return false
    try { await runPowerShell(runtimeScript('Word.Application')); return true } catch { return false }
  }

  async embed(docxPath: string, replacements: readonly { placeholder: string; visioPath: string }[]): Promise<void> {
    if (!(await this.isAvailable())) throw new Error(`${WORD_RUNTIME_UNAVAILABLE}: 当前环境未检测到 Microsoft Word。`)
    await runPowerShell(embedScript(docxPath, replacements))
  }

  async countVisioObjects(docxPath: string): Promise<number> {
    if (!(await this.isAvailable())) throw new Error(`${WORD_RUNTIME_UNAVAILABLE}: 当前环境未检测到 Microsoft Word。`)
    const output = await runPowerShell(`$word = $null
$document = $null
try {
  $word = New-Object -ComObject 'Word.Application'
  $document = $word.Documents.Open(${decodeScriptValue(docxPath)}, $false, $true)
  $count = 0
  foreach ($shape in $document.InlineShapes) { try { if ([string]$shape.OLEFormat.ProgID -like 'Visio*') { $count++ } } catch { <# Non-OLE inline shapes do not expose OLEFormat. #> } }
  Write-Output $count
} finally {
  if ($null -ne $document) { $document.Close() }
  if ($null -ne $word) { $word.Quit() }
}`)
    return Number.parseInt(output.trim(), 10) || 0
  }
}

/** Construct the real Windows COM implementation; callers may inject fakes for portable tests.
 * @returns Paired Windows Visio and Word COM capabilities.
 */
export function createNativeVisioExport(): NativeVisioExport {
  return { visio: new NativeVisioBackend(), word: new NativeWordVisioEmbedder(), finalizer: createNativeWordFinalizer() }
}

/** 流程图导出支持的运行模式。 */
export type FlowchartExportMode = 'editable' | 'image_fallback'

/** 流程图导出环境检测结果与决策详情。 */
export interface FlowchartExportEnvironment {
  readonly mode: FlowchartExportMode
  readonly hasVisio: boolean
  readonly hasWord: boolean
  readonly reasons: readonly string[]
  readonly summary: string
}

/**
 * 检测当前环境的 Visio 与 Word 支持能力，并判定走可编辑还是图片兼容模式。
 * @param office 可选的能力接口注入；未提供时检测真实系统 COM 能力。
 * @returns 模式判定结果与具体说明。
 */
export async function detectFlowchartExportEnvironment(
  office: NativeVisioExport = createNativeVisioExport(),
): Promise<FlowchartExportEnvironment> {
  const [hasVisio, hasWord] = await Promise.all([
    office.visio.isAvailable(),
    office.word.isAvailable(),
  ])
  const reasons: string[] = []
  if (!hasVisio) reasons.push('未检测到 Microsoft Visio')
  if (!hasWord) reasons.push('未检测到 Microsoft Word')
  if (process.platform !== 'win32') reasons.push('当前运行环境非 Windows 平台，不支持 Office COM 自动化')

  const mode: FlowchartExportMode = (hasVisio && hasWord) ? 'editable' : 'image_fallback'
  const summary = mode === 'editable'
    ? '检测到 Microsoft Visio 与 Word 环境，流程图以可编辑 OLE 形式嵌入。'
    : `检测到当前环境缺少 Office 组件（${reasons.join('；')}），已自动切换为图片兼容模式导出；流程图以高清图片形式插入文档并保留源数据。`

  return { mode, hasVisio, hasWord, reasons, summary }
}
