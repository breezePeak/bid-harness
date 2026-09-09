/** Filesystem path checks shared by Bid workspace writes and validators. */

import { randomBytes } from 'node:crypto'
import { lstat, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Resolve a relative workspace path only when it remains below its owning root.
 * @param root Owning workspace root.
 * @param candidate Untrusted project-relative path.
 * @returns Absolute path contained strictly below the owning root.
 */
export function within(root: string, candidate: string): string {
  if (isAbsolute(candidate) || /^[a-z]:/iu.test(candidate) || /^\\\\/u.test(candidate)) throw new Error('bid-absolute-path')
  const target = resolve(root, candidate)
  const rel = relative(root, target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('bid-path-traversal')
  return target
}

/**
 * Reject an existing symbolic link or junction anywhere below an owning root.
 * @param root - lexical root whose own spelling may itself be a Host-selected alias.
 * @param target - absolute target lexically contained by `root`.
 */
export async function assertNoLinkedPath(root: string, target: string): Promise<void> {
  const rel = relative(root, target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('bid-workspace-path-outside-root')
  }
  let current = root
  for (const component of rel.split(sep)) {
    current = resolve(current, component)
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('bid-workspace-symbolic-link')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

/** 安全地原子替换项目内二进制文件，失败保留旧文件。
 * @param root 项目所属工作区。
 * @param target 经过范围检查的绝对目标。
 * @param bytes 原始文件字节。
 */
export async function atomicBytes(root: string, target: string, bytes: Uint8Array): Promise<void> {
  await assertNoLinkedPath(root, target)
  await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 })
  await assertNoLinkedPath(root, target)
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
