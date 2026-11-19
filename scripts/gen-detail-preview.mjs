/**
 * gen-detail-preview — rebuild the localized feature previews under `detail/`.
 *
 * The Plugin Manager's bundle page renders a bundle's `meta.detail` document;
 * ours is a single feature illustration, the upstream convention (640×300
 * self-contained SVG, every glyph outlined — `<text>`, scripts and external
 * resources are forbidden). This script lays the composition out in data and
 * outlines each string through fontkit, so the shipped files hold path data
 * only and render identically on every platform.
 *
 * The layout mirrors the official previews (e.g. agent-team-profile): a large
 * title plus subtitle on the left above one summary card, and one panel card
 * on the right showing the feature's own UI — the Workspace Folders panel.
 * Icons are not redrawn: the outline path data is lifted from the installed
 * `@deepseek-ai/dsh-client-ui-primitives` build (the same glyphs the panel
 * renders) and from `src/client/WorkspaceFoldersAction.tsx`'s inline glyphs.
 *
 * One variant is emitted per language DSH ships in the box (`preview.<id>.svg`,
 * English being the bare `preview.svg`). The panel's own copy is wider than
 * English in several languages, so every run is measured and shrunk until it
 * fits its slot: the composition adapts instead of overflowing.
 *
 * Fonts are read from the macOS system library (SF for Latin and Cyrillic,
 * Hiragino Sans GB + Songti for Chinese, Yu Gothic + Yu Mincho for Japanese,
 * the last two from downloadable font assets) — run `pnpm preview:gen` on
 * macOS after editing the strings or layout below, and commit the regenerated
 * SVGs.
 *
 * @module scripts/gen-detail-preview
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/* ---------------------------------------------------------------------------
 * Fonts.
 *
 * SF carries Latin AND Cyrillic, so Russian needs no separate face; Georgia
 * Bold (the serif the official previews use for the large title) covers
 * Cyrillic too. Chinese and Japanese need their own faces: the Japanese
 * family ships as downloadable assets, so it is resolved by name rather than
 * by a fixed versioned path.
 * ------------------------------------------------------------------------ */
const FONT_ASSETS = '/System/Library/AssetsV2/com_apple_MobileAsset_Font7'

/** Open a font by absolute path, failing loudly when the file is absent. */
function openFont(file, face) {
  if (!existsSync(file)) throw new Error(`missing font ${file} — the preview generator needs this macOS font`)
  return face === undefined ? fontkit.openSync(file) : fontkit.openSync(file, face)
}

/** Open a downloadable font asset by file name (faces live in versioned dirs). */
function openAssetFont(name, face) {
  const candidates = existsSync(FONT_ASSETS)
    ? readdirSync(FONT_ASSETS, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(FONT_ASSETS, entry.name, 'AssetData', name))
    : []
  const file = candidates.find(candidate => existsSync(candidate))
  if (file === undefined) {
    throw new Error(`missing font asset ${name} — install the matching font in Font Book (macOS offers Japanese fonts as downloads)`)
  }
  return face === undefined ? fontkit.openSync(file) : fontkit.openSync(file, face)
}

const SF = openFont('/System/Library/Fonts/SFNS.ttf')
const SF_SEMI = SF.getVariation({ wght: 600 })
const MONO = openFont('/System/Library/Fonts/SFNSMono.ttf').getVariation({ wght: 500 })
/** The official previews set the large title in a serif face. */
const GEORGIA_BOLD = openFont('/System/Library/Fonts/Supplemental/Georgia Bold.ttf')

const ZH_UI = openFont('/System/Library/Fonts/Hiragino Sans GB.ttc', 'HiraginoSansGB-W3')
const ZH_SEMI = openFont('/System/Library/Fonts/Hiragino Sans GB.ttc', 'HiraginoSansGB-W6')
const ZH_BOLD = openFont('/System/Library/Fonts/Supplemental/Songti.ttc', 'STSongti-SC-Bold')

const JA_UI = openAssetFont('YuGothic-Medium.otf')
const JA_SEMI = openAssetFont('YuGothic-Bold.otf')
const JA_BOLD = openAssetFont('YuMincho.ttc', 'YuMin-Extrabold')

const LATIN_FACES = { ui: SF, semi: SF_SEMI, bold: GEORGIA_BOLD, mono: MONO }
const ZH_FACES = { ui: ZH_UI, semi: ZH_SEMI, bold: ZH_BOLD, mono: MONO }
const JA_FACES = { ui: JA_UI, semi: JA_SEMI, bold: JA_BOLD, mono: MONO }

const C = {
  bg: '#F5F6FC',
  card: '#FFFFFF',
  inner: '#FAFBFE',
  border: '#DFE4EF',
  divider: '#E6EAF2',
  shadow: '#1F2A44',
  ink: '#1F2A44',
  body: '#38425A',
  muted: '#7A859E',
  faint: '#ACB5CF',
  accent: '#4D6BFE',
  accentSoft: '#E8EDFF',
  bubble: '#EEF2FF',
  tag: '#F0F2FA',
}

const num = value => Number(value.toFixed(2))

/* ---------------------------------------------------------------------------
 * Real icon geometry.
 *
 * The icon table in the installed ui-primitives build stores each glyph as a
 * `svg: (strokeWidth) => `<svg …>` template on a 16-unit grid. Extract the
 * inner elements verbatim and re-emit them inside a positioned <g>, with
 * `currentColor` resolved to the requested ink. ReadOnlyArtwork, SkillsIcon
 * and the dialog's CloseIcon live outside that table (React artwork / the
 * panel's own inline svg), so their path data is copied from source below —
 * if upstream or the panel redraws those glyphs, update the constants.
 * ------------------------------------------------------------------------ */
const PRIMITIVES_LIB = join(
  REPO_ROOT, 'node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js',
)

function iconEntry(key) {
  const src = readFileSync(PRIMITIVES_LIB, 'utf8')
  const start = src.indexOf(`\t"${key}": {`)
  if (start < 0) throw new Error(`icon ${key} not found in ui-primitives build`)
  const next = src.indexOf('\n\t"', start + 1)
  const block = src.slice(start, next < 0 ? undefined : next)
  const view = Number(block.match(/viewBox="0 0 (\d+) \d+"/)?.[1] ?? 16)
  const svg = block.match(/svg: \(strokeWidth\) => `([\s\S]*?)`/)?.[1]
  if (!svg) throw new Error(`icon ${key}: svg template not found`)
  const inner = svg
    .replace(/\$\{strokeWidth\}/g, '1')
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>[\s\S]*$/, '')
    .replace(/currentColor/g, '@')
  return { view, inner }
}

/** Emit one table glyph at (x, y) top-left, `size` px tall, `color` ink. */
function icon(key, x, y, size, color) {
  const { view, inner } = iconEntry(key)
  const s = num(size / view)
  const body = inner.replace(/@/g, color)
  return `<g transform="translate(${num(x)} ${num(y)}) scale(${s})" fill="none" stroke="${color}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">${body}</g>`
}

/* `PermissionIconReadOnlyRegular` — shield and check, 16-grid, stroke 1. */
const READONLY_PATHS = [
  'M5.08545 8.13775L7.18455 10.2368C7.26636 10.3187 7.4003 10.3142 7.47649 10.2271L11.5148 5.61194',
  'M6.59624 2.14853C7.50155 1.80917 8.49914 1.80919 9.40444 2.14859L13.9245 3.84317V7.11961C13.9245 11.6089 10.5565 13.5975 8.00035 14.5779C5.44423 13.5975 2.07544 11.6089 2.07544 7.11961V3.84317L6.59624 2.14853Z',
]
/* `SkillsIcon` — document with the skills sparkle, 16-grid, stroke 1. */
const SKILLS_PATHS = [
  'M8 13.5H3a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1V7M4.5 4.5h5M4.5 7h3',
  'm11.5 8 .85 2.65L15 11.5l-2.65.85-.85 2.65-.85-2.65L8 11.5l2.65-.85Z',
]
/* The dialog header's close glyph, 16-grid, stroke 1.2. */
const CLOSE_PATH = 'M4 4l8 8M12 4l-8 8'

function pathGroup(paths, x, y, size, color, strokeWidth = 1) {
  const s = num(size / 16)
  const body = paths.map(d => `<path d="${d}"/>`).join('')
  return `<g transform="translate(${num(x)} ${num(y)}) scale(${s})" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${body}</g>`
}

/* ---------------------------------------------------------------------------
 * Text outlining and fitting.
 * ------------------------------------------------------------------------ */
function outline(font, str, x, y, size, fill) {
  const scale = size / font.unitsPerEm
  const { glyphs, positions } = font.layout(str)
  let pen = 0
  const parts = []
  for (let index = 0; index < glyphs.length; index++) {
    const glyph = glyphs[index]
    if (glyph.path.commands.length > 0) {
      const offset = positions[index]
      parts.push(`<path transform="translate(${num(pen + offset.xOffset)} ${num(-offset.yOffset)})" d="${glyph.path.toSVG()}"/>`)
    }
    pen += positions[index].xAdvance
  }
  return {
    svg: `<g transform="translate(${num(x)} ${num(y)}) scale(${scale.toFixed(5)} ${(-scale).toFixed(5)})" fill="${fill}">${parts.join('')}</g>`,
    width: pen * scale,
  }
}

/** Advance width of `str` at `size`, without emitting anything. */
function measure(font, str, size) {
  const scale = size / font.unitsPerEm
  return font.layout(str).positions.reduce((total, position) => total + position.xAdvance, 0) * scale
}

/** One language's renderable face set, plus a per-style measure. */
function fontSet(faces) {
  return {
    ui: spec => outline(faces.ui, spec.str, spec.x, spec.y, spec.size, spec.fill),
    semi: spec => outline(faces.semi, spec.str, spec.x, spec.y, spec.size, spec.fill),
    bold: spec => outline(faces.bold, spec.str, spec.x, spec.y, spec.size, spec.fill),
    mono: spec => outline(faces.mono, spec.str, spec.x, spec.y, spec.size, spec.fill),
    measure: (style, str, size) => measure(faces[style], str, size),
  }
}

/**
 * Shrink `size` until `str` fits `maxWidth`.
 *
 * Translated copy is routinely wider than English, so every constrained run
 * goes through this instead of a hand-tuned size per language. The step is
 * small enough that the result stays visually even across the variants.
 * @param L - the language being rendered (carries `font.measure`).
 * @param style - face to measure with.
 * @param str - the string.
 * @param size - the preferred size.
 * @param maxWidth - the horizontal budget in canvas units.
 * @param min - the floor; copy that still overflows there is a content bug.
 * @returns the fitted size.
 */
function fit(L, style, str, size, maxWidth, min = 5) {
  let candidate = size
  while (candidate > min && L.font.measure(style, str, candidate) > maxWidth) {
    candidate = Number((candidate - 0.1).toFixed(2))
  }
  const width = L.font.measure(style, str, candidate)
  if (width > maxWidth) {
    throw new Error(`copy does not fit its slot: ${JSON.stringify(str)} needs ${width.toFixed(1)} > ${maxWidth} at ${candidate}px`)
  }
  return candidate
}

/* A white card with the official previews' offset shadow. */
function card(x, y, w, h, rx = 12, border = C.border, fill = C.card) {
  return [
    `<rect x="${x}" y="${y + 3}" width="${w}" height="${h}" rx="${rx}" fill="${C.shadow}" opacity="0.04"/>`,
    `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="${rx}" fill="${fill}" stroke="${border}" stroke-width="1"/>`,
  ].join('')
}

const hline = (x1, x2, y) => `<path d="M${x1} ${y}L${x2} ${y}" stroke="${C.divider}"/>`

/* The neutral cwd chip (`mrfw-cwdTag`): tag bg, secondary ink. */
function cwdTag(L, x, baseline) {
  const size = fit(L, 'ui', L.cwdTag, 6.5, 104, 5)
  const label = L.font.ui({ str: L.cwdTag, x: 0, y: 0, size, fill: C.muted })
  const w = Math.ceil(label.width + 10)
  return {
    svg: `<rect x="${x}" y="${baseline - 9.5}" width="${w}" height="13" rx="3.5" fill="${C.tag}"/>`
      + L.font.ui({ str: L.cwdTag, x: x + 5, y: baseline, size, fill: C.muted }).svg,
    width: w,
  }
}

/* Access badge: the row's real permission glyph + muted label, no chip. */
function accessBadge(kind, L, label, x, baseline) {
  const iconSize = 10
  const iconY = baseline - 8 // icon box vertically centered on the small text
  const glyph = kind === 'inherit'
    ? icon('workspace-tree-outline', x, iconY, iconSize, C.muted)
    : pathGroup(READONLY_PATHS, x, iconY, iconSize, C.muted)
  const size = fit(L, 'ui', label, 7.5, 112, 6)
  const labelText = L.font.ui({ str: label, x: x + iconSize + 4, y: baseline, size, fill: C.muted })
  return { svg: glyph + labelText.svg, width: iconSize + 4 + labelText.width }
}

/* Row trailing actions: skills toggle, reveal-in-folder, ⋯ menu. */
function rowActions(centerY, right) {
  const size = 12
  const y = centerY - size / 2
  const xs = [right - size, right - size * 2 - 8, right - size * 3 - 16]
  return (
    icon('ellipsis-outline', xs[0], y, size, C.muted)
    + icon('folder-open-outline', xs[1], y, size, C.muted)
    + pathGroup(SKILLS_PATHS, xs[2], y, size, C.muted)
  )
}

/* ---------------------------------------------------------------------------
 * Left column: large title + subtitle over one session summary card.
 * ------------------------------------------------------------------------ */
function leftBlock(L) {
  const parts = []
  const push = run => { parts.push(run.svg); return run }

  push(L.font.bold({ str: L.title, x: 34, y: 64, size: fit(L, 'bold', L.title, L.titleSize, 262, 9), fill: C.ink }))
  push(L.font.ui({ str: L.subtitle, x: 34, y: 90, size: fit(L, 'ui', L.subtitle, 11, 262, 7), fill: C.muted }))

  const X = 32, Y = 124, W = 252, H = 144
  parts.push(card(X, Y, W, H))
  const tx = X + 16
  const right = X + W - 12

  // The trigger pill — the sidebar action that opens the panel, like the
  // upstream previews' entry-point badge. Measured first because the
  // right-aligned pill decides how much room the card title keeps.
  const badgeSize = fit(L, 'ui', L.badge, 9.5, 132, 6.5)
  const badgeLabel = L.font.ui({ str: L.badge, x: 0, y: 0, size: badgeSize, fill: C.accent })
  const badgeW = Math.ceil(8 + 12 + 5 + badgeLabel.width + 8)
  const badgeX = right - badgeW

  // The title's ink (not baseline) shares the header's vertical center with
  // the badge pill: 12px caps sit ~5px above their midpoint.
  push(L.font.semi({
    str: L.cardTitle,
    x: tx,
    y: Y + 28,
    size: fit(L, 'semi', L.cardTitle, 12, badgeX - 8 - tx - 4, 7),
    fill: C.ink,
  }))
  parts.push(`<rect x="${badgeX}" y="${Y + 11}" width="${badgeW}" height="24" rx="6" fill="${C.accentSoft}"/>`)
  parts.push(icon('settings-outline', badgeX + 8, Y + 17, 12, C.accent))
  parts.push(L.font.ui({ str: L.badge, x: badgeX + 8 + 12 + 5, y: Y + 26.5, size: badgeSize, fill: C.accent }).svg)

  parts.push(hline(X + 1, X + W - 1, Y + 44))
  // The connector from the badge row to the panel, as upstream draws it.
  parts.push(`<path d="M${badgeX + badgeW} ${Y + 23}H312" stroke="${C.faint}"/>`)
  parts.push(`<circle cx="312" cy="${Y + 23}" r="2.5" fill="${C.faint}"/>`)

  // The request, as a right-aligned user bubble (two lines max).
  const lineSize1 = fit(L, 'ui', L.userLine1, 8.5, 186, 6.5)
  const lineSize2 = fit(L, 'ui', L.userLine2, 8.5, 186, 6.5)
  const line1 = L.font.ui({ str: L.userLine1, x: 0, y: 0, size: lineSize1, fill: C.ink })
  const line2 = L.font.ui({ str: L.userLine2, x: 0, y: 0, size: lineSize2, fill: C.ink })
  const bubbleW = Math.ceil(Math.max(line1.width, line2.width) + 18)
  const bubbleX = X + W - 14 - bubbleW
  parts.push(`<rect x="${bubbleX}" y="${Y + 56}" width="${bubbleW}" height="44" rx="10" fill="${C.bubble}"/>`)
  parts.push(L.font.ui({ str: L.userLine1, x: bubbleX + 9, y: Y + 73, size: lineSize1, fill: C.ink }).svg)
  parts.push(L.font.ui({ str: L.userLine2, x: bubbleX + 9, y: Y + 91, size: lineSize2, fill: C.ink }).svg)

  push(L.font.ui({ str: L.status, x: tx, y: Y + 124, size: fit(L, 'ui', L.status, 8.5, 214, 6.5), fill: C.muted }))
  return parts.join('')
}

/* ---------------------------------------------------------------------------
 * Right card: the Workspace Folders panel — section labels, name + access
 * badge over the mono path, divider-separated rows, centered-height footer
 * button.
 * ------------------------------------------------------------------------ */
function panelCard(L) {
  const X = 312, Y = 32, W = 296, H = 236
  const pad = 16
  const tx = X + pad
  const right = X + W - pad
  const parts = [card(X, Y, W, H)]
  const push = run => { parts.push(run.svg); return run }

  push(L.font.semi({ str: L.panelTitle, x: tx, y: Y + 25, size: fit(L, 'semi', L.panelTitle, 11.5, 214, 7), fill: C.ink }))
  parts.push(pathGroup([CLOSE_PATH], right - 11, Y + 14, 11, C.muted, 1.2))

  // Section: primary working directory.
  push(L.font.ui({ str: L.primary, x: tx, y: Y + 46, size: fit(L, 'ui', L.primary, 8.5, 236, 6), fill: C.muted }))
  const primaryRowY = Y + 52
  const primaryName = push(L.font.semi({ str: 'web-app', x: tx, y: primaryRowY + 15, size: 10, fill: C.ink }))
  parts.push(cwdTag(L, tx + primaryName.width + 6, primaryRowY + 15).svg)
  push(L.font.mono({ str: '~/dev/web-app', x: tx, y: primaryRowY + 29, size: 7.5, fill: C.muted }))
  parts.push(hline(tx, right, primaryRowY + 38))

  // Section: secondary working directories.
  push(L.font.ui({ str: L.secondary, x: tx, y: primaryRowY + 54, size: fit(L, 'ui', L.secondary, 8.5, 236, 6), fill: C.muted }))
  const rows = [
    { name: 'shared-libs', path: '~/dev/shared-libs', access: 'inherit', label: L.inherit },
    { name: 'design-assets', path: '~/dev/design-assets', access: 'read-only', label: L.readOnly },
  ]
  let rowTop = primaryRowY + 60
  for (const row of rows) {
    const name = push(L.font.semi({ str: row.name, x: tx, y: rowTop + 15, size: 10, fill: C.ink }))
    parts.push(accessBadge(row.access, L, row.label, tx + name.width + 8, rowTop + 15).svg)
    parts.push(rowActions(rowTop + 11, right))
    push(L.font.mono({ str: row.path, x: tx, y: rowTop + 29, size: 7.5, fill: C.muted }))
    parts.push(hline(tx, right, rowTop + 38))
    rowTop += 44
  }

  // Footer: the outline add button, visually centered between the last row's
  // divider and the card's bottom edge.
  const dividerY = rowTop - 6
  const btnH = 20
  const btnY = dividerY + (Y + H - dividerY - btnH) / 2
  const plus = 9
  const addSize = fit(L, 'ui', L.add, 8.5, 128, 6.5)
  const addLabel = L.font.ui({ str: L.add, x: 0, y: 0, size: addSize, fill: C.body })
  const btnW = Math.ceil(12 + plus + 5 + addLabel.width + 12)
  parts.push(`<rect x="${tx + 0.5}" y="${btnY + 0.5}" width="${btnW - 1}" height="${btnH - 1}" rx="${btnH / 2}" fill="${C.card}" stroke="${C.border}"/>`)
  parts.push(icon('plus-outline', tx + 12, btnY + (btnH - plus) / 2, plus, C.body))
  parts.push(L.font.ui({ str: L.add, x: tx + 12 + plus + 5, y: btnY + 13.5, size: addSize, fill: C.body }).svg)
  return parts.join('')
}

function preview(L) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300"><rect width="640" height="300" fill="${C.bg}"/>${leftBlock(L)}${panelCard(L)}</svg>\n`
}

/* ---------------------------------------------------------------------------
 * Copy, one table per language (the panel's own labels, not a separate
 * vocabulary). `titleSize` is the preferred large-title size; `fit` shrinks
 * it when the language needs more room.
 * ------------------------------------------------------------------------ */
const COPY = {
  en: {
    title: 'Multi-root workspace',
    titleSize: 19,
    subtitle: 'One session, many working directories',
    cardTitle: 'Sync API types',
    badge: 'Folders',
    panelTitle: 'Workspace folders',
    primary: 'Primary working directory',
    cwdTag: 'Current Agent working directory',
    secondary: 'Secondary working directories',
    inherit: 'Inherit',
    readOnly: 'Read Only',
    add: 'Add folder',
    userLine1: 'Mirror the new API types into',
    userLine2: 'shared-libs and run its tests',
    status: 'Added shared-libs as a secondary directory.',
  },
  zh: {
    title: '多根工作区',
    titleSize: 21,
    subtitle: '一个会话，多个工作目录',
    cardTitle: '同步 API 类型',
    badge: '工作区目录',
    panelTitle: '工作区目录',
    primary: '主要工作目录',
    cwdTag: '当前Agent工作目录',
    secondary: '附属工作目录',
    inherit: '跟随会话',
    readOnly: '仅可查看',
    add: '添加目录',
    userLine1: '把新的 API 类型同步到',
    userLine2: 'shared-libs，并跑一遍测试',
    status: '已将 shared-libs 添加为附属目录。',
  },
  ja: {
    title: 'マルチルートワークスペース',
    titleSize: 19,
    subtitle: '1 つのセッション、複数の作業ディレクトリ',
    cardTitle: 'API 型を同期',
    badge: 'フォルダー',
    panelTitle: 'ワークスペースフォルダー',
    primary: '主要な作業ディレクトリ',
    cwdTag: 'Agent の現在の作業ディレクトリ',
    secondary: '追加の作業ディレクトリ',
    inherit: 'セッションに従う',
    readOnly: '読み取り専用',
    add: 'フォルダーを追加',
    userLine1: '新しい API 型を',
    userLine2: 'shared-libs に反映してテストを実行',
    status: 'shared-libs を追加の作業ディレクトリとして登録しました。',
  },
  es: {
    title: 'Espacio de trabajo multi-raíz',
    titleSize: 17,
    subtitle: 'Una sesión, varios directorios de trabajo',
    cardTitle: 'Sincronizar tipos de API',
    badge: 'Carpetas',
    panelTitle: 'Carpetas del espacio de trabajo',
    primary: 'Directorio de trabajo principal',
    cwdTag: 'Directorio de trabajo actual del Agent',
    secondary: 'Directorios de trabajo secundarios',
    inherit: 'Heredar',
    readOnly: 'Solo lectura',
    add: 'Añadir carpeta',
    userLine1: 'Copia los nuevos tipos de API en',
    userLine2: 'shared-libs y ejecuta sus pruebas',
    status: 'Se añadió shared-libs como directorio adicional.',
  },
  fr: {
    title: 'Espace de travail multi-racines',
    titleSize: 17,
    subtitle: 'Une session, plusieurs répertoires de travail',
    cardTitle: 'Synchroniser les types d’API',
    badge: 'Dossiers',
    panelTitle: 'Dossiers de l’espace de travail',
    primary: 'Répertoire de travail principal',
    cwdTag: 'Répertoire de travail actuel de l’Agent',
    secondary: 'Répertoires de travail secondaires',
    inherit: 'Hériter de la session',
    readOnly: 'Lecture seule',
    add: 'Ajouter un dossier',
    userLine1: 'Recopie les nouveaux types d’API dans',
    userLine2: 'shared-libs et lance ses tests',
    status: 'shared-libs a été ajouté comme répertoire supplémentaire.',
  },
  de: {
    title: 'Multi-Root-Arbeitsbereich',
    titleSize: 16,
    subtitle: 'Eine Sitzung, viele Arbeitsverzeichnisse',
    cardTitle: 'API-Typen synchronisieren',
    badge: 'Ordner',
    panelTitle: 'Arbeitsbereichsordner',
    primary: 'Primäres Arbeitsverzeichnis',
    cwdTag: 'Aktuelles Arbeitsverzeichnis des Agenten',
    secondary: 'Sekundäre Arbeitsverzeichnisse',
    inherit: 'Von Sitzung übernehmen',
    readOnly: 'Nur lesen',
    add: 'Ordner hinzufügen',
    userLine1: 'Spiegele die neuen API-Typen nach',
    userLine2: 'shared-libs und führe dessen Tests aus',
    status: 'shared-libs wurde als zusätzlicher Ordner hinzugefügt.',
  },
  ru: {
    title: 'Рабочее пространство с несколькими корнями',
    titleSize: 15,
    subtitle: 'Один сеанс, много рабочих каталогов',
    cardTitle: 'Синхронизировать типы API',
    badge: 'Папки',
    panelTitle: 'Папки рабочего пространства',
    primary: 'Основная рабочая папка',
    cwdTag: 'Текущий рабочий каталог Agent',
    secondary: 'Дополнительные рабочие папки',
    inherit: 'Наследовать',
    readOnly: 'Только чтение',
    add: 'Добавить папку',
    userLine1: 'Скопируй новые типы API в',
    userLine2: 'shared-libs и запусти его тесты',
    status: 'shared-libs добавлен как дополнительный каталог.',
  },
  pt: {
    title: 'Espaço de trabalho multi-raiz',
    titleSize: 17,
    subtitle: 'Uma sessão, vários diretórios de trabalho',
    cardTitle: 'Sincronizar tipos de API',
    badge: 'Pastas',
    panelTitle: 'Pastas do espaço de trabalho',
    primary: 'Diretório de trabalho principal',
    cwdTag: 'Diretório de trabalho atual do Agent',
    secondary: 'Diretórios de trabalho secundários',
    inherit: 'Herdar',
    readOnly: 'Somente leitura',
    add: 'Adicionar pasta',
    userLine1: 'Copie os novos tipos de API para',
    userLine2: 'shared-libs e execute os testes',
    status: 'shared-libs foi adicionado como diretório adicional.',
  },
}

/** Emitted files, in the order DSH's language menu lists them. */
const VARIANTS = [
  { id: 'en', file: 'preview.svg', faces: LATIN_FACES },
  { id: 'zh', file: 'preview.zh.svg', faces: ZH_FACES },
  { id: 'ja', file: 'preview.ja.svg', faces: JA_FACES },
  { id: 'es', file: 'preview.es.svg', faces: LATIN_FACES },
  { id: 'fr', file: 'preview.fr.svg', faces: LATIN_FACES },
  { id: 'de', file: 'preview.de.svg', faces: LATIN_FACES },
  { id: 'ru', file: 'preview.ru.svg', faces: LATIN_FACES },
  { id: 'pt', file: 'preview.pt.svg', faces: LATIN_FACES },
]

for (const { id, file, faces } of VARIANTS) {
  const copy = COPY[id]
  if (copy === undefined) throw new Error(`no preview copy for locale ${id}`)
  const svg = preview({ ...copy, font: fontSet(faces) })
  const target = join(REPO_ROOT, 'detail', file)
  writeFileSync(target, svg)
  const bytes = statSync(target).size
  console.log(`[gen-detail-preview] ${file.padEnd(18)} ${(bytes / 1024).toFixed(1)} KiB`)
  if (bytes > 1024 * 1024) throw new Error(`${file} exceeds the 1 MiB preview budget`)
}
