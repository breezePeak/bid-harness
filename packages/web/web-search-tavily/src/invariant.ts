/** Package invariant companion for `@deepseek-ai/dsh-web-search-tavily`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-web-search-tavily'

/** Cordis companion plugin name. */
export const name = 'web-search-tavily-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']

/** No runtime invariant: provider state is enforced by the owning Web registry and request validation. */
const install: InvariantInstaller = () => {}

/** Register package ownership with the invariant service. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
