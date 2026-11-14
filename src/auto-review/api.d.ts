import type { Context } from '@deepseek-ai/cordis'
/** Optional Auto Review Loader entry; supported on the joint contract's exact releases (see compat/auto-review-contract). */
export declare const name: string
export declare const inject: string[]
export declare function apply(ctx: Context): Promise<void>
