/** Filesystem path checks shared by Bid workspace writes and validators. */

import { lstat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

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
