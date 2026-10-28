/**
 * Fork-facing shim for `isMobileDevice` from
 * `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The verbatim `open-toast.tsx` spells this specifier where upstream writes
 * the primitives import (joined only in `0.2.2-alpha.2`); the
 * release-dependent probe and fallback live in
 * `src/compat/open-in-app-device.ts` — version-dependent code belongs only
 * under `src/compat/`. See FORK.md.
 */

export { isMobileDevice } from '../../compat/open-in-app-device.ts'
