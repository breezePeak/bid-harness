/** 文件接入的纯校验；普通附件和专业导入共用。 */
import { extname } from 'node:path'
import type { BidConfig, IncomingFile } from './index.ts'
import { isBidDocumentRole } from './control-plane-contract.ts'

/**
 * 拒绝不适用于工作区文件系统的上传文件名。
 * @param name 用户提供的文件名。
 * @returns 规范化后的安全文件名。
 */
export function safeFileName(name: string): string {
  const trimmed = name.normalize('NFC').trim()
  if (trimmed.length === 0 || /[\\/:\x00-\x1f<>"|?*]/u.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new Error('bid-invalid-file-name')
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu.test(trimmed)) throw new Error('bid-reserved-file-name')
  return trimmed
}

/**
 * 在任何写入前验证整个文件批次。
 * @param files 完整上传字节与元数据。
 * @param config Host 文件大小、数量和扩展名限制。
 */
export function validateBidFileBatch(files: readonly IncomingFile[], config: BidConfig): void {
  if (files.length === 0 || files.length > config.maxFiles) throw new Error('bid-file-count-limit')
  const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0)
  if (!Number.isSafeInteger(total) || total > config.maxTotalBytes) throw new Error('bid-total-size-limit')
  for (const file of files) {
    if (file.role !== undefined && !isBidDocumentRole(file.role)) throw new Error('bid-invalid-file-role')
    const originalName = safeFileName(file.name)
    const extension = extname(originalName).toLocaleLowerCase('en-US')
    if (!config.allowedExtensions.includes(extension)) throw new Error('bid-unsupported-file-type')
    if (file.bytes.byteLength === 0) throw new Error('bid-empty-file')
    if (file.bytes.byteLength > config.maxFileBytes) throw new Error('bid-file-size-limit')
  }
}
