/** Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-bid`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-bid'

/** Cordis companion plugin name. */
export const name = 'client-ui-bid-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Bid state remains owned by the Host projection; this UI package owns no runtime relationship to assert. */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
