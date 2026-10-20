import type { Context } from '@deepseek-ai/cordis'
/** Optional Auto Review Loader entry; supported only on DSH 0.2.1-rc.2. */
export declare const name: string
export declare const inject: string[]
export declare function apply(ctx: Context): Promise<void>
