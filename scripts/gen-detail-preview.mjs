/**
 * gen-detail-preview — rebuild `detail/preview.svg` and `detail/preview.zh.svg`.
 *
 * The Plugin Manager's bundle page renders a bundle's `meta.detail` document;
 * ours is a single feature illustration, the upstream convention (640×300
 * self-contained SVG, every glyph outlined — `<text>`, scripts and external
 * resources are forbidden). This script lays the composition out in data and
 * outlines each string through fontkit, so the shipped file holds path data
 * only and renders identically on every platform.
 *
 * The layout mirrors the official previews (e.g. agent-team-profile): a large
 * title plus subtitle on the left above one summary card, and one panel card
 * on the right showing the feature's own UI — the Workspace Folders panel.
 * Icons are not redrawn: the outline path data is lifted from the installed
 * `@deepseek-ai/dsh-client-ui-primitives` build (the same glyphs the panel
 * renders) and from `src/client/WorkspaceFoldersAction.tsx`'s inline glyphs.
 *
 * Fonts are read from the macOS system library (SF for Latin, Hiragino Sans GB
 * for Chinese) — run `pnpm preview:gen` on macOS after editing the strings or
 * layout below, and commit the regenerated SVGs.
 *
 * @module scripts/gen-detail-preview
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const FONTS = {
  en: fontkit.openSync('/System/Library/Fonts/SFNS.ttf'),
  enMono: fontkit.openSync('/System/Library/Fonts/SFNSMono.ttf'),
  zh: fontkit.openSync('/System/Library/Fonts/Hiragino Sans GB.ttc', 'HiraginoSansGB-W3'),
  zhBold: fontkit.openSync('/System/Library/Fonts/Hiragino Sans GB.ttc', 'HiraginoSansGB-W6'),
}
FONTS.enSemi = FONTS.en.getVariation({ wght: 600 })
FONTS.enBold = FONTS.en.getVariation({ wght: 700 })
FONTS.enMono = FONTS.enMono.getVariation({ wght: 500 })
// The official previews set the large title in a serif face.
FONTS.enSerif = fontkit.openSync('/System/Library/Fonts/Supplemental/Georgia Bold.ttf')
FONTS.zhSerif = fontkit.openSync('/System/Library/Fonts/Supplemental/Songti.ttc', 'STSongti-SC-Bold')

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
 * Text outlining.
 * ------------------------------------------------------------------------ */
function text(font, str, x, y, size, fill) {
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

const FONT = {
  en: {
    ui: s => text(FONTS.en, s.str, s.x, s.y, s.size, s.fill),
    semi: s => text(FONTS.enSemi, s.str, s.x, s.y, s.size, s.fill),
    bold: s => text(FONTS.enSerif, s.str, s.x, s.y, s.size, s.fill),
    mono: s => text(FONTS.enMono, s.str, s.x, s.y, s.size, s.fill),
  },
  zh: {
    ui: s => text(FONTS.zh, s.str, s.x, s.y, s.size, s.fill),
    semi: s => text(FONTS.zhBold, s.str, s.x, s.y, s.size, s.fill),
    bold: s => text(FONTS.zhSerif, s.str, s.x, s.y, s.size, s.fill),
    mono: s => text(FONTS.enMono, s.str, s.x, s.y, s.size, s.fill),
  },
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
  const label = L.font.ui({ str: L.cwdTag, x: 0, y: 0, size: 6.5, fill: C.muted })
  const w = Math.ceil(label.width + 10)
  return {
    svg: `<rect x="${x}" y="${baseline - 9.5}" width="${w}" height="13" rx="3.5" fill="${C.tag}"/>`
      + L.font.ui({ str: L.cwdTag, x: x + 5, y: baseline, size: 6.5, fill: C.muted }).svg,
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
  const labelText = L.font.ui({ str: label, x: x + iconSize + 4, y: baseline, size: 7.5, fill: C.muted })
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

  push(L.font.bold({ str: L.title, x: 34, y: 64, size: L.titleSize, fill: C.ink }))
  push(L.font.ui({ str: L.subtitle, x: 34, y: 90, size: 11, fill: C.muted }))

  const X = 32, Y = 124, W = 252, H = 144
  parts.push(card(X, Y, W, H))
  const tx = X + 16
  const right = X + W - 12

  // The title's ink (not baseline) shares the header's vertical center with
  // the badge pill: 12px caps sit ~5px above their midpoint.
  push(L.font.semi({ str: L.cardTitle, x: tx, y: Y + 28, size: 12, fill: C.ink }))

  // The trigger pill — the sidebar action that opens the panel, like the
  // upstream previews' entry-point badge.
  const badgeLabel = L.font.ui({ str: L.badge, x: 0, y: 0, size: 9.5, fill: C.accent })
  const badgeW = Math.ceil(8 + 12 + 5 + badgeLabel.width + 8)
  const badgeX = right - badgeW
  parts.push(`<rect x="${badgeX}" y="${Y + 11}" width="${badgeW}" height="24" rx="6" fill="${C.accentSoft}"/>`)
  parts.push(icon('settings-outline', badgeX + 8, Y + 17, 12, C.accent))
  parts.push(L.font.ui({ str: L.badge, x: badgeX + 8 + 12 + 5, y: Y + 26.5, size: 9.5, fill: C.accent }).svg)

  parts.push(hline(X + 1, X + W - 1, Y + 44))
  // The connector from the badge row to the panel, as upstream draws it.
  parts.push(`<path d="M${badgeX + badgeW} ${Y + 23}H312" stroke="${C.faint}"/>`)
  parts.push(`<circle cx="312" cy="${Y + 23}" r="2.5" fill="${C.faint}"/>`)

  // The request, as a right-aligned user bubble (two lines max).
  const line1 = L.font.ui({ str: L.userLine1, x: 0, y: 0, size: 8.5, fill: C.ink })
  const line2 = L.font.ui({ str: L.userLine2, x: 0, y: 0, size: 8.5, fill: C.ink })
  const bubbleW = Math.ceil(Math.max(line1.width, line2.width) + 18)
  const bubbleX = X + W - 14 - bubbleW
  parts.push(`<rect x="${bubbleX}" y="${Y + 56}" width="${bubbleW}" height="44" rx="10" fill="${C.bubble}"/>`)
  parts.push(L.font.ui({ str: L.userLine1, x: bubbleX + 9, y: Y + 73, size: 8.5, fill: C.ink }).svg)
  parts.push(L.font.ui({ str: L.userLine2, x: bubbleX + 9, y: Y + 91, size: 8.5, fill: C.ink }).svg)

  push(L.font.ui({ str: L.status, x: tx, y: Y + 124, size: 8.5, fill: C.muted }))
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

  push(L.font.semi({ str: L.panelTitle, x: tx, y: Y + 25, size: 11.5, fill: C.ink }))
  parts.push(pathGroup([CLOSE_PATH], right - 11, Y + 14, 11, C.muted, 1.2))

  // Section: primary working directory.
  push(L.font.ui({ str: L.primary, x: tx, y: Y + 46, size: 8.5, fill: C.muted }))
  const primaryRowY = Y + 52
  const primaryName = push(L.font.semi({ str: 'web-app', x: tx, y: primaryRowY + 15, size: 10, fill: C.ink }))
  parts.push(cwdTag(L, tx + primaryName.width + 6, primaryRowY + 15).svg)
  push(L.font.mono({ str: '~/dev/web-app', x: tx, y: primaryRowY + 29, size: 7.5, fill: C.muted }))
  parts.push(hline(tx, right, primaryRowY + 38))

  // Section: secondary working directories.
  push(L.font.ui({ str: L.secondary, x: tx, y: primaryRowY + 54, size: 8.5, fill: C.muted }))
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
  const addLabel = L.font.ui({ str: L.add, x: 0, y: 0, size: 8.5, fill: C.body })
  const btnW = Math.ceil(12 + plus + 5 + addLabel.width + 12)
  parts.push(`<rect x="${tx + 0.5}" y="${btnY + 0.5}" width="${btnW - 1}" height="${btnH - 1}" rx="${btnH / 2}" fill="${C.card}" stroke="${C.border}"/>`)
  parts.push(icon('plus-outline', tx + 12, btnY + (btnH - plus) / 2, plus, C.body))
  parts.push(L.font.ui({ str: L.add, x: tx + 12 + plus + 5, y: btnY + 13.5, size: 8.5, fill: C.body }).svg)
  return parts.join('')
}

function preview(L) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300"><rect width="640" height="300" fill="${C.bg}"/>${leftBlock(L)}${panelCard(L)}</svg>\n`
}

const EN = {
  font: FONT.en,
  title: 'Multi-root workspace',
  titleSize: 19,
  subtitle: 'One session, many working directories',
  cardTitle: 'Sync API types',
  badge: 'Workspace folders',
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
}

const ZH = {
  font: FONT.zh,
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
}

writeFileSync(join(REPO_ROOT, 'detail/preview.svg'), preview(EN))
writeFileSync(join(REPO_ROOT, 'detail/preview.zh.svg'), preview(ZH))
console.log('[gen-detail-preview] wrote detail/preview.svg and detail/preview.zh.svg')
