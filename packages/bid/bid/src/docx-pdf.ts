/** 正式 DOCX 的 LibreOffice PDF 渲染。 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function subprocessEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key, item]) =>
    item !== undefined && !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(key)))
}

/**
 * 使用当前正式分页链路把 DOCX 转为 PDF。
 * @param docx 完整 DOCX 字节。
 * @returns LibreOffice 生成的 PDF 字节。
 */
export async function renderDocxPdf(docx: Buffer): Promise<Uint8Array> {
  return (await renderDocxPdfWithInfo(docx)).pdf
}

/**
 * 使用已安装的 LibreOffice 渲染，保留实际后端版本并响应所属 Run 的取消。
 * @param docx 完整 DOCX 字节。
 * @param signal 当前任务的取消信号。
 * @returns 真实 PDF 和用于绑定页面检查缓存的后端身份。
 */
export async function renderDocxPdfWithInfo(docx: Buffer, signal?: AbortSignal): Promise<{ pdf: Uint8Array; renderer: string }> {
  signal?.throwIfAborted()
  const root = await mkdtemp(join(tmpdir(), 'dsh-bid-pages-'))
  const input = join(root, 'estimate.docx')
  const output = join(root, 'estimate.pdf')
  try {
    await writeFile(input, docx, { flag: 'wx', mode: 0o600 })
    const profile = join(root, 'profile')
    const candidates = process.platform === 'win32'
      ? [process.env.ProgramFiles && join(process.env.ProgramFiles, 'LibreOffice/program/soffice.com'),
        process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'LibreOffice/program/soffice.com'),
        'soffice'].filter((item): item is string => Boolean(item))
      : ['soffice', 'libreoffice']
    let unavailable: unknown
    for (const executable of candidates) {
      let version: { stdout: string }
      try {
        version = await execFileAsync(executable, ['--version'], { env: subprocessEnvironment(), timeout: 10_000,
          maxBuffer: 1024 * 1024, windowsHide: true, ...(signal === undefined ? {} : { signal }) })
      } catch (error) {
        unavailable = error
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        continue
      }
      await execFileAsync(executable, [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        '--headless', '--convert-to', 'pdf', '--outdir', root, input,
      ], { cwd: root, env: subprocessEnvironment(), timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true,
        ...(signal === undefined ? {} : { signal }) })
      signal?.throwIfAborted()
      return { pdf: await readFile(output), renderer: version.stdout.trim() }
    }
    throw unavailable instanceof Error ? unavailable : new Error('LibreOffice 不可用。')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
