/** Flowchart rasterization rendering to high-fidelity PNG for DOCX embedding. */

import sharp from 'sharp'
import { renderFlowchartSvg, type FlowchartSpec } from './flowchart.ts'

/** Rendered flowchart outputs with both vector SVG and rasterized PNG bytes. */
export interface RenderedFlowchartImage {
  readonly svg: string
  readonly png: Buffer
  readonly width: number
  readonly height: number
}

/**
 * Render a validated FlowchartSpec to SVG and rasterize it to PNG using sharp.
 * @param spec Validated flowchart specification.
 * @returns Vector SVG, rasterized PNG buffer, and canvas dimensions.
 */
export async function renderFlowchartImage(spec: FlowchartSpec): Promise<RenderedFlowchartImage> {
  const { svg, width, height } = renderFlowchartSvg(spec)
  const png = await sharp(Buffer.from(svg, 'utf8')).png().toBuffer()
  return { svg, png, width, height }
}
