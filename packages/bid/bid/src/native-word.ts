/** Windows Microsoft Word 字段刷新能力。 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 无 Microsoft Word 时返回给调用方的稳定警告码。 */
export const DOCX_TOC_UPDATE_DEFERRED = 'DOCX_TOC_UPDATE_DEFERRED'
/** Word COM 无法激活时的稳定错误码。 */
export const WORD_FINALIZER_UNAVAILABLE = 'WORD_FINALIZER_UNAVAILABLE'

/** 最终 DOCX 的 Word 字段刷新能力。 */
export interface WordDocumentFinalizer {
  isAvailable(): Promise<boolean>
  updateFields(docxPath: string): Promise<void>
}

const encoded = (value: string): string => Buffer.from(value, 'utf8').toString('base64')
const scriptValue = (value: string): string => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded(value)}'))`
const scrubbedEnvironment = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env)
  .filter(([name, value]) => value !== undefined && !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)))

async function runPowerShell(script: string, timeout = 120_000): Promise<void> {
  await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], { env: scrubbedEnvironment(), windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 })
}

let availability: Promise<boolean> | undefined

class NativeWordDocumentFinalizer implements WordDocumentFinalizer {
  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'win32') return false
    availability ??= (async () => {
      try {
        await runPowerShell(`$word = $null
try {
  $word = New-Object -ComObject 'Word.Application'
  if ($null -eq $word) { throw 'COM unavailable' }
} finally {
  if ($null -ne $word) {
    try { $word.Quit() } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) | Out-Null }
  }
}`, 2_000)
        return true
      } catch { return false }
    })()
    return availability
  }

  async updateFields(docxPath: string): Promise<void> {
    if (!(await this.isAvailable())) throw new Error(`${WORD_FINALIZER_UNAVAILABLE}: 当前环境未检测到 Microsoft Word。`)
    await runPowerShell(`$ErrorActionPreference = 'Stop'
$path = ${scriptValue(docxPath)}
$word = $null
$document = $null
try {
  $word = New-Object -ComObject 'Word.Application'
  $word.Visible = $false
  $document = $word.Documents.Open($path, $false, $false)
  $document.Fields.Update() | Out-Null
  for ($index = 1; $index -le $document.TablesOfContents.Count; $index++) {
    $toc = $document.TablesOfContents.Item($index)
    $toc.Update()
    $toc.UpdatePageNumbers()
  }
  $document.Save()
} finally {
  try {
    if ($null -ne $document) { $document.Close() }
  } finally {
    if ($null -ne $document) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) | Out-Null }
    if ($null -ne $word) {
      try { $word.Quit() } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) | Out-Null }
    }
  }
}`)
  }
}

/** @returns 当前 Windows 宿主上的 Microsoft Word COM finalizer。 */
export function createNativeWordFinalizer(): WordDocumentFinalizer {
  return new NativeWordDocumentFinalizer()
}
