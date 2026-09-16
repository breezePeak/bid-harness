/** Web-domain zod schemas for the browser provider selector. */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { WebCapabilityView, WebProviderDiagnostic, WebProviderView } from './web.ts'

/** Wire schema for one Web provider's secret-free diagnostic. */
export const webProviderDiagnosticSchema = z.object({
  available: z.boolean(),
  reason: z.enum(['credentials', 'configuration', 'unknown']).optional(),
  endpoint: z.string().optional(),
  credentialRef: z.string().optional(),
  credentialSource: z.string().optional(),
}) satisfies z.ZodType<Wire<WebProviderDiagnostic>>

/** Wire schema for one registered Web provider. */
export const webProviderViewSchema = z.object({
  id: z.string().min(1),
  diagnostic: webProviderDiagnosticSchema,
}) satisfies z.ZodType<Wire<WebProviderView>>

/** Wire schema for one Web capability's provider directory. */
export const webCapabilityViewSchema = z.object({
  configuredId: z.string().optional(),
  selectedProviderId: z.string().optional(),
  providers: z.array(webProviderViewSchema),
}) satisfies z.ZodType<Wire<WebCapabilityView>>

/** Request schema for the Web diagnostics RPC. */
export const webDiagnoseRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'web.diagnose'>>>

/** Response schema for the Web diagnostics RPC. */
export const webDiagnoseValueSchema = z.object({
  search: webCapabilityViewSchema,
  fetch: webCapabilityViewSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'web.diagnose'>>>
