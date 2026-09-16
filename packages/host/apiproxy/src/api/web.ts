/** Web-domain contract for the browser's search-provider selector. */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Secret-free provider health and endpoint information. */
export interface WebProviderDiagnostic {
  /** Whether the provider can serve requests with its current local state. */
  available: boolean
  /** Why a provider is unavailable, when the provider can classify it. */
  reason?: 'credentials' | 'configuration' | 'unknown'
  /** Provider endpoint, without credential material. */
  endpoint?: string
  /** Credential reference, never the credential value. */
  credentialRef?: string
  /** Where the credential was found, when safely disclosed. */
  credentialSource?: string
}

/** One registered Web provider and its local diagnostic. */
export interface WebProviderView {
  /** Stable provider id used by `web.searchProvider`. */
  id: string
  /** Secret-free local health and configuration facts. */
  diagnostic: WebProviderDiagnostic
}

/** One Web capability's configured and currently usable providers. */
export interface WebCapabilityView {
  /** Explicitly configured provider id, if the capability is pinned. */
  configuredId?: string
  /** Provider selected by the runtime, if it is currently usable. */
  selectedProviderId?: string
  /** All registered providers for this capability. */
  providers: readonly WebProviderView[]
}

/** The Web search and fetch provider directory. */
export interface WebDiagnosticsView {
  /** Search provider registry and route selection. */
  search: WebCapabilityView
  /** Fetch provider registry and route selection. */
  fetch: WebCapabilityView
}

/** Web-domain unary methods. */
export interface WebApi {
  /** Return the registered providers and the route currently selected for each capability. */
  diagnose(request: RpcRequest<{}>): Promise<RpcResponse<WebDiagnosticsView>>
}
