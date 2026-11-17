// @vitest-environment jsdom
/**
 * The three-tier root-name fit, exercised with a deterministic measurer.
 *
 * The fit is pure geometry: a character-width table stands in for the label's
 * font, so the expected strings below are exact. The component side — reading
 * the header's width budget and re-fitting on resize — is pinned by
 * \`client-root-name-room.spec.ts\` and \`client-switcher.spec.tsx\`; the
 * stylesheet's fallback ellipsis and the truncated-name path rule by
 * \`client-styles.spec.ts\`.
 */

import { describe, expect, it } from 'vitest'
import {
  ROOT_NAME_ALIGN_SLACK_CHARS,
  ROOT_NAME_ELLIPSIS,
  ROOT_NAME_MAX_TAIL,
  ROOT_NAME_MIN_HEAD,
  ROOT_NAME_MIN_TAIL,
  fitRootName,
  type TextMeasure,
} from '../src/client/root-name-fit.ts'

/** Every ASCII character is 7px, CJK is 13px and the ellipsis is 7px. */
const measure: TextMeasure = text => Array.from(text)
  .reduce((sum, char) => sum + (/[\u3000-\u9fff\uff00-\uffef]/.test(char) ? 13 : 7), 0)

/** The name every tier case is checked against. */
const NAME = 'dsh-plugin-multi-root-workspace'

/** Lone surrogates a broken code-point split would leave behind. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe('the root-name fit', () => {
  it('keeps the whole name once it fits', () => {
    expect(fitRootName(NAME, measure(NAME), measure)).toEqual({ form: 'full', text: NAME })
    expect(fitRootName(NAME, 400, measure)).toEqual({ form: 'full', text: NAME })
  })

  it('keeps both ends while they fit, preferring word boundaries', () => {
    expect(fitRootName(NAME, 180, measure)).toEqual({ form: 'middle', text: 'dsh-plugin…root-workspace' })
    // Two visible characters are given up so the kept ends sit on separators.
    expect(fitRootName(NAME, 160, measure)).toEqual({ form: 'middle', text: 'dsh-plugin…workspace' })
    expect(fitRootName(NAME, 120, measure)).toEqual({ form: 'middle', text: 'dsh-plu…workspace' })
    expect(fitRootName(NAME, 104, measure)).toEqual({ form: 'middle', text: 'dsh…workspace' })
  })

  it('shows different endings for names that share a prefix', () => {
    const experiment = 'dsh-plugin-multi-root-workspace-experiment'
    expect(fitRootName(experiment, 210, measure)).toEqual({ form: 'middle', text: 'dsh…root-workspace-experiment' })
    expect(fitRootName(experiment, 160, measure)).toEqual({ form: 'middle', text: 'dsh-plugin…experiment' })
  })

  it('drops the tail when even a short one no longer fits', () => {
    expect(fitRootName(NAME, 55, measure)).toEqual({ form: 'head', text: 'dsh…' })
    expect(fitRootName(NAME, 28, measure)).toEqual({ form: 'head', text: 'dsh…' })
    expect(fitRootName(NAME, 18, measure)).toEqual({ form: 'head', text: 'd…' })
  })

  it('degrades to the ellipsis alone and then to nothing', () => {
    expect(fitRootName(NAME, measure(ROOT_NAME_ELLIPSIS), measure)).toEqual({ form: 'head', text: ROOT_NAME_ELLIPSIS })
    expect(fitRootName(NAME, measure(ROOT_NAME_ELLIPSIS) - 1, measure)).toEqual({ form: 'head', text: '' })
    expect(fitRootName(NAME, 0, measure)).toEqual({ form: 'head', text: '' })
  })

  it('handles names without separators and multibyte characters', () => {
    expect(fitRootName('myproject', 55, measure)).toEqual({ form: 'head', text: 'myproj…' })
    expect(fitRootName('数据管理平台', 78, measure)).toEqual({ form: 'full', text: '数据管理平台' })
    expect(fitRootName('数据管理平台', 70, measure)).toEqual({ form: 'head', text: '数据管理…' })
  })

  it('never splits a surrogate pair', () => {
    const name = '🚀a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p'
    for (const available of [120, 90, 70, 60, 50, 40, 30, 20]) {
      expect(fitRootName(name, available, measure).text).not.toMatch(LONE_SURROGATE)
    }
  })

  it('keeps the minimum ends and stays inside the measured width', () => {
    for (let available = 30; available <= measure(NAME) + 10; available += 1) {
      const fitted = fitRootName(NAME, available, measure)
      expect(measure(fitted.text)).toBeLessThanOrEqual(Math.ceil(available))
      if (fitted.form === 'middle') {
        const [head = '', tail = ''] = fitted.text.split(ROOT_NAME_ELLIPSIS)
        expect(Array.from(head).length).toBeGreaterThanOrEqual(ROOT_NAME_MIN_HEAD)
        const tailLength = Array.from(tail).length
        expect(tailLength).toBeGreaterThanOrEqual(ROOT_NAME_MIN_TAIL)
        // The character-level fallback caps its tail; a word-aligned tail may
        // run past the cap because it keeps a whole trailing word.
        const startsWord = NAME[NAME.length - tailLength - 1]?.match(/[-_. /\\:]/) !== undefined
        if (!startsWord) expect(tailLength).toBeLessThanOrEqual(ROOT_NAME_MAX_TAIL)
        expect(NAME.startsWith(head)).toBe(true)
        expect(NAME.endsWith(tail)).toBe(true)
      }
      if (fitted.form === 'head') {
        expect(fitted.text.endsWith(ROOT_NAME_ELLIPSIS) || fitted.text === '').toBe(true)
        expect(NAME.startsWith(fitted.text.slice(0, -1))).toBe(true)
      }
    }
  })

  it('treats an unknown width as "show it whole"', () => {
    expect(fitRootName(NAME, Number.NaN, measure)).toEqual({ form: 'full', text: NAME })
  })

  it('takes a whole name that is empty', () => {
    expect(fitRootName('', 100, measure)).toEqual({ form: 'full', text: '' })
  })

  it('prefers the word-aligned split within the alignment slack', () => {
    // The widest character-level split is a little longer than the aligned one;
    // the aligned one wins because it gives up no more than the slack.
    expect(ROOT_NAME_ALIGN_SLACK_CHARS).toBeGreaterThan(0)
    expect(fitRootName(NAME, 160, measure).text).toBe('dsh-plugin…workspace')
  })
})
