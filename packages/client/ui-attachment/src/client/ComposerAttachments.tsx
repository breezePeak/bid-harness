import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ComposerAttachment, ComposerAttachmentsProps,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AttachmentRail } from '../AttachmentRail.tsx'
import type { AttachmentRailItem } from '../AttachmentRail.tsx'
import { DropOverlay } from '../DropOverlay.tsx'
import { ImageLightbox } from '../ImageLightbox.tsx'
import { attachmentRailLabels, dropOverlayLabels, lightboxLabels } from './labels.ts'
import css from './ComposerAttachments.module.css'

/** Rail item retaining its browser-owned attachment for callbacks. */
interface ComposerRailItem extends AttachmentRailItem {
  attachment: ComposerAttachment
}

/** Draft-image rail, document drop target, and original-image preview slot entry. */
export function ComposerAttachments({
  attachments, canAcceptDrop, submitting, onAddImages, onRemoveImage, dropLimits, t,
}: ComposerAttachmentsProps) {
  const [preview, setPreview] = useState<ComposerAttachment | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const picker = useRef<HTMLInputElement>(null)
  const closePreview = useCallback(() => { setPreview(null) }, [])

  useEffect(() => {
    if (preview !== null && !attachments.some(attachment => attachment.id === preview.id)) setPreview(null)
  }, [attachments, preview])

  useEffect(() => {
    const fileTransfer = (event: globalThis.DragEvent): DataTransfer | null => {
      const dataTransfer = event.dataTransfer
      if (dataTransfer === null || !dataTransfer.types.includes('Files')) return null
      return dataTransfer
    }
    const reset = (): void => {
      dragDepth.current = 0
      setDragActive(false)
    }
    const onDragEnter = (event: globalThis.DragEvent): void => {
      if (fileTransfer(event) === null) return
      event.preventDefault()
      dragDepth.current += 1
      setDragActive(true)
    }
    const onDragOver = (event: globalThis.DragEvent): void => {
      const dataTransfer = fileTransfer(event)
      if (dataTransfer === null) return
      event.preventDefault()
      dataTransfer.dropEffect = canAcceptDrop ? 'copy' : 'none'
    }
    const onDragLeave = (event: globalThis.DragEvent): void => {
      if (fileTransfer(event) === null) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragActive(false)
      const leftViewport = event.clientX <= 0 || event.clientY <= 0
        || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight
      if ((event.target === document.documentElement || event.target === document.body) && leftViewport) reset()
    }
    const onDrop = (event: globalThis.DragEvent): void => {
      const dataTransfer = fileTransfer(event)
      if (dataTransfer === null) return
      event.preventDefault()
      reset()
      if (canAcceptDrop) onAddImages([...dataTransfer.files])
    }
    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    window.addEventListener('dragend', reset)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', reset)
    }
  }, [canAcceptDrop, onAddImages])

  const railItems = useMemo<ComposerRailItem[]>(() => attachments.map(attachment => ({
    id: attachment.id,
    previewUrl: attachment.kind === 'image' ? attachment.previewUrl : undefined,
    alt: attachment.file.name || t('image.pending'),
    removeLabel: t('image.remove', { name: attachment.file.name }),
    attachment,
  })), [attachments, t])

  return (
    <>
      <div className={css.addRow}>
        <button type="button" className={css.add} disabled={!canAcceptDrop} onClick={() => { picker.current?.click() }}>添加附件</button>
        <input ref={picker} type="file" hidden multiple accept=".doc,.docx,.pdf,.xls,.xlsx,.txt,.md,image/png,image/jpeg,image/webp,image/gif"
          aria-label="选择附件" disabled={!canAcceptDrop} onChange={(event) => {
            onAddImages(Array.from(event.currentTarget.files ?? []))
            event.currentTarget.value = ''
          }} />
        {submitting && attachments.length > 0 && <span role="status">正在上传并发送附件…</span>}
      </div>
      {dragActive && (
        <DropOverlay
          disabled={!canAcceptDrop}
          labels={dropOverlayLabels(t, canAcceptDrop, dropLimits)}
        />
      )}
      {railItems.length > 0 && (
        <div className={css.rail}>
          <AttachmentRail
            items={railItems}
            labels={attachmentRailLabels(t)}
            onOpen={(item) => { if (item.attachment.kind === 'image') setPreview(item.attachment) }}
            onRemove={(item) => { onRemoveImage(item.attachment.id) }}
          />
        </div>
      )}
      {preview?.kind === 'image' && (
        <ImageLightbox
          src={preview.previewUrl}
          alt={preview.file.name || t('image.original')}
          labels={lightboxLabels(t)}
          onClose={closePreview}
        />
      )}
    </>
  )
}
