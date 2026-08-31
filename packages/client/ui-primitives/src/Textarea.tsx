import type { TextareaHTMLAttributes } from 'react'
import clsx from 'clsx'
import css from './Textarea.module.css'

/** Render a token-styled multiline input while passing standard textarea attributes through. */
export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={clsx(css.textarea, className)} {...props} />
}
