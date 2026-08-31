/** React portal primitive with an explicit destination supplied by the owner. */
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Render children into an owner-provided element without creating a second React root.
 * @param props - Portal destination and child tree.
 * @returns the portal, or nothing until the destination mounts.
 */
export function Portal({ container, children }: { container: HTMLElement | null; children: ReactNode }) {
  return container === null ? null : createPortal(children, container)
}
