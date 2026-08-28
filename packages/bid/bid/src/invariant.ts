/** Package-owned invariant companion for the bid workspace helpers. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-bid'
export const name = 'bid-invariant'
export const inject = ['invariants']
// No runtime invariant: this package owns file transformations but no mutable relationship between services.
const install: InvariantInstaller = () => {}
/** Register the package companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
