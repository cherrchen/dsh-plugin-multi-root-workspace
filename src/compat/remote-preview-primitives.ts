import type { ComponentType } from 'react'
import { IconFolderOpen, maybeComponent, maybeIcon } from './client-icons.ts'

interface PreviewCodeBlockProps {
  readonly code: string
  readonly lang: string
  readonly className: string
  readonly wrap: boolean
  readonly lineNumbers: boolean
  readonly copyLabel: string
  readonly copiedLabel: string
  readonly toolbarLabels: {
    readonly codeLabel: string
    readonly wrapLabel: string
    readonly unwrapLabel: string
  }
}

// Pixel-era hosts lack some of these exports, and the first Regular-era
// CodeBlock does not consume wrap. The Viewer owns the wrap CSS in either case.
export const PreviewCodeBlock = maybeComponent<ComponentType<PreviewCodeBlockProps>>(['CodeBlock'])
export const previewLanguageForPath = maybeComponent<(path: string) => string | undefined>(['languageForPath'])
export const PreviewPathLabel = maybeComponent<ComponentType<{ path: string; className: string }>>(['PathLabel'])
export const PreviewFolderOpenIcon = maybeIcon(['IconFolderOpenRegular', 'IconFolderOpen16']) ?? IconFolderOpen
export const PreviewUnwrapIcon = maybeIcon(['IconNowrapFillRegular'])
export const PreviewWrapIcon = maybeIcon(['IconWrapFillRegular'])
