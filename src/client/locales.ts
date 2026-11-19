/**
 * The panel's copy, one module per language DSH ships in the box.
 *
 * The client registers `zh`, `en`, `ja`, `es`, `fr`, `de`, `ru` and `pt`. Chinese
 * stays the canonical shape (`Key` is `keyof typeof zh`), and every other
 * dictionary is pinned to it by `satisfies`, so a missing translation is a
 * type error; `tests/locale-parity.spec.ts` compares the shipped dictionaries
 * at runtime, placeholders included.
 *
 * `ctx.locale.register` accepts dictionaries for locales a host does not
 * register as selectable languages — they are simply never consulted — so
 * shipping all eight costs older releases in the support matrix nothing: they
 * keep offering whichever languages they shipped, and the panel follows the
 * interface language the host actually selects.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/locales
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { zh, type Key } from './locales/zh.ts'
import { en } from './locales/en.ts'
import { ja } from './locales/ja.ts'
import { es } from './locales/es.ts'
import { fr } from './locales/fr.ts'
import { de } from './locales/de.ts'
import { ru } from './locales/ru.ts'
import { pt } from './locales/pt.ts'

/** The locale namespace this plugin owns. */
export const NS = 'multiRootWorkspace'

export { zh, en, ja, es, fr, de, ru, pt }
export type { Key }

/** Every shipped dictionary, keyed by DSH locale id. */
export const DICTIONARIES = { zh, en, ja, es, fr, de, ru, pt }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's panel copy. */
    multiRootWorkspace: Key
  }
}
