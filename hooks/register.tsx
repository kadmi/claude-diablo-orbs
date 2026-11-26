import { atom, read, update } from 'claude-code'
import type { Register, SessionRateLimit } from 'claude-code'

import type { Gauges } from '../types'

const gauges = atom({ plugin: 'diablo-orbs', key: 'gauges' } as const, {
  contextUsed: null,
  limitUsed: null,
  limitKind: null,
} as Gauges)

type Palette = { shine: string; core: string; body: string; rim: string }
type Span = { text: string; fg?: string; bg?: string; bold?: boolean; dim?: boolean }

const LIFE: Palette = { shine: '#ffb0a8', core: '#e0201a', body: '#a80e0c', rim: '#5c0505' }
const MANA: Palette = { shine: '#b8c8ff', core: '#2a4ce8', body: '#1832a8', rim: '#0a1658' }
const GLASS: Palette = { shine: '#5a5a5a', core: '#262626', body: '#1e1e1e', rim: '#141414' }
const STONE = '#8a8174'
const LABEL = '#f4ecd8'
const MAX_ROWS = 5
const MIN_COLUMNS_ORBS = 48
const MIN_COLUMNS_FIGURES = 100

// The statues flanking the orbs: the angel holds the life orb, the demon the mana orb.
// Each mask marks per character: g gold, p pale stone, r ember red, anything else plain stone.
const ANGEL = [
  ' _.-.  _  ',
  '/ /\\ \\(_) ',
  '| | \\_/|\\_',
  '\\ \\ \\ / \\ ',
  " `-'/___\\ ",
]
const ANGEL_MASK = ['       g  ', '      ppp ', '        gg', '          ', '          ']
const DEMON = [
  ' \\/  .-._ ',
  '(oo)/ /\\ \\',
  '_/|\\_/ | |',
  ' / \\ / / /',
  "/___\\`-'  ",
]
const DEMON_MASK = ['          ', ' rr       ', '          ', '          ', '          ']
const FIGURE_TONES: Record<string, string> = { g: '#d4a94a', p: '#c9c1b2', r: '#ff3b1f' }

const ANSI_BASE = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
]

const pickLimit = (limits: readonly SessionRateLimit[]) =>
  limits.find(l => l.kind === 'five_hour') ?? limits[0] ?? null

const shortKind = (kind: string | null) =>
  kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind === null ? '' : 'lim'

const toGauges = (contextUsed: number | undefined, limits: readonly SessionRateLimit[]): Gauges => {
  const limit = pickLimit(limits)

  return {
    contextUsed: contextUsed ?? null,
    limitUsed: limit?.percentUsed ?? null,
    limitKind: limit?.kind ?? null,
  }
}

const remaining = (used: number | null) =>
  used === null ? null : Math.max(0, Math.min(100, 100 - used))

const hex = (n: number) => n.toString(16).padStart(2, '0')

function xterm256(n: number): string | undefined {
  if (n < 16) return ANSI_BASE[n]
  if (n >= 232) {
    const level = 8 + (n - 232) * 10
    return `#${hex(level)}${hex(level)}${hex(level)}`
  }
  const cube = n - 16
  const level = (v: number) => (v === 0 ? 0 : 55 + v * 40)

  return `#${hex(level(Math.floor(cube / 36)))}${hex(level(Math.floor(cube / 6) % 6))}${hex(level(cube % 6))}`
}

// claude-hud prints SGR-coloured lines; turn them into spans this mod can draw itself.
function parseAnsi(source: string): Span[][] {
  const clean = source
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-La-ln-z]/g, '')
  const style: Omit<Span, 'text'> = {}

  const apply = (codes: number[]) => {
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i] ?? 0
      if (code === 0) {
        delete style.fg
        delete style.bg
        delete style.bold
        delete style.dim
      } else if (code === 1) style.bold = true
      else if (code === 2) style.dim = true
      else if (code === 22) {
        delete style.bold
        delete style.dim
      } else if (code >= 30 && code <= 37) style.fg = ANSI_BASE[code - 30]
      else if (code >= 90 && code <= 97) style.fg = ANSI_BASE[code - 82]
      else if (code >= 40 && code <= 47) style.bg = ANSI_BASE[code - 40]
      else if (code >= 100 && code <= 107) style.bg = ANSI_BASE[code - 92]
      else if (code === 39) delete style.fg
      else if (code === 49) delete style.bg
      else if (code === 38 || code === 48) {
        const key = code === 38 ? 'fg' : 'bg'
        if (codes[i + 1] === 5) {
          style[key] = xterm256(codes[i + 2] ?? 0)
          i += 2
        } else if (codes[i + 1] === 2) {
          style[key] = `#${hex(codes[i + 2] ?? 0)}${hex(codes[i + 3] ?? 0)}${hex(codes[i + 4] ?? 0)}`
          i += 4
        }
      }
    }
  }

  return clean.split('\n').map(line => {
    const spans: Span[] = []
    for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
      const sgr = /^\x1b\[([0-9;]*)m$/.exec(part)
      if (sgr) apply((sgr[1] || '0').split(';').map(Number))
      else if (part) spans.push({ text: part, ...style })
    }
    return spans
  })
}

// The orb is a circle on a grid of half-rows: each terminal cell holds two
// vertically stacked "pixels" drawn with ▀/▄, which makes them roughly square.
function orbSpans(rows: number, fill: number | null, palette: Palette, caption: string): Span[][] {
  const columns = rows * 2
  const halfRows = rows * 2
  const radius = rows + 0.35
  const centerX = columns / 2
  const centerY = halfRows / 2
  const shineX = centerX - radius * 0.38
  const shineY = centerY - radius * 0.42
  const surface = halfRows - Math.round(((fill ?? 100) / 100) * halfRows)

  const pixel = (x: number, y: number): string | undefined => {
    const distance = Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY)
    if (distance > radius) return undefined

    const tone = y >= surface ? palette : GLASS
    if (Math.hypot(x + 0.5 - shineX, y + 0.5 - shineY) < radius * 0.26) return tone.shine
    if (distance > radius - 1.1) return tone.rim
    if (distance < radius * 0.5) return tone.core

    return tone.body
  }

  const grid: Span[][] = []
  for (let row = 0; row < rows; row++) {
    const line: Span[] = []
    for (let x = 0; x < columns; x++) {
      const top = pixel(x, row * 2)
      const bottom = pixel(x, row * 2 + 1)
      if (!top && !bottom) line.push({ text: ' ' })
      else if (top === bottom) line.push({ text: '█', fg: top })
      else if (!top) line.push({ text: '▄', fg: bottom })
      else if (!bottom) line.push({ text: '▀', fg: top })
      else line.push({ text: '▀', fg: top, bg: bottom })
    }
    grid.push(line)
  }

  const stamp = (row: number, text: string) => {
    const line = grid[row]
    if (!line || text.length > columns) return
    const start = Math.floor((columns - text.length) / 2)
    ;[...text].forEach((ch, i) => {
      const under = line[start + i]
      line[start + i] = { text: ch, fg: LABEL, bg: under?.bg ?? under?.fg ?? GLASS.body, bold: true }
    })
  }

  const middle = Math.floor((rows - 1) / 2)
  stamp(middle, fill === null ? '--' : `${Math.round(fill)}%`)
  if (rows >= 4) stamp(middle + 1, caption)

  return grid
}

function figureSpans(art: string[], mask: string[], rows: number): Span[][] {
  return art.slice(art.length - rows).map((line, row) => {
    const tones = mask[art.length - rows + row] ?? ''
    return [...line].map((ch, i) => ({ text: ch, fg: FIGURE_TONES[tones[i] ?? ''] ?? STONE }))
  })
}

const pillarSpans = (rows: number, glyph: string): Span[][] =>
  Array.from({ length: rows }, () => [{ text: glyph, fg: STONE }])

function merge(line: Span[]): Span[] {
  const spans: Span[] = []
  for (const span of line) {
    const last = spans[spans.length - 1]
    const same = last && last.fg === span.fg && last.bg === span.bg && last.bold === span.bold && last.dim === span.dim
    if (same) last.text += span.text
    else spans.push({ ...span })
  }

  return spans
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const usage = await $.session.usage()
    await update($, gauges, () => toGauges(usage.context.percent, usage.rateLimits))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, gauges, () => toGauges(e.context.percent, e.rateLimits))

    return next(e)
  })

  on('ui.render', { component: 'StatusLine' }, async ($, e, next) => {
    const { contextUsed, limitUsed, limitKind } = await read($, gauges)
    const life = remaining(contextUsed)
    const mana = remaining(limitUsed)
    const rows = Math.min(MAX_ROWS, e.props.maxRows)

    if (rows < 2 || e.props.columns < MIN_COLUMNS_ORBS) {
      const percent = (value: number | null) => (value === null ? '--' : `${Math.round(value)}%`)
      const gauge = `♥ ${percent(life)}  ✦ ${percent(mana)}`
      const text = e.props.text ? `${e.props.text}  ${gauge}` : gauge
      return next({ ...e, props: { ...e.props, text } })
    }

    const { Box, Text } = $.ui.resolve(e)
    const withFigures = e.props.columns >= MIN_COLUMNS_FIGURES

    const column = (key: string, grid: Span[][], shrink = 0) => (
      <Box key={key} flexDirection="column" flexShrink={shrink}>
        {grid.map((line, row) => (
          <Text key={`${key}-${row}`} wrap="truncate-end">
            {merge(line).map((span, i) => (
              <Text
                key={String(i)}
                color={span.fg}
                backgroundColor={span.bg}
                bold={span.bold}
                dimColor={span.dim}
              >
                {span.text}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
    )

    const hud = e.props.text ? parseAnsi(e.props.text).slice(0, rows) : []

    return (
      <Box flexDirection="row">
        {withFigures ? column('angel', figureSpans(ANGEL, ANGEL_MASK, rows)) : null}
        {column('life', orbSpans(rows, life, LIFE, 'ctx'))}
        {column('left-pillar', pillarSpans(rows, '▐'))}
        <Box key="hud" flexDirection="column" flexGrow={1} flexShrink={1} justifyContent="center" paddingX={1}>
          {column('hud-lines', hud, 1)}
        </Box>
        {column('right-pillar', pillarSpans(rows, '▌'))}
        {column('mana', orbSpans(rows, mana, limitUsed === null ? GLASS : MANA, shortKind(limitKind)))}
        {withFigures ? column('demon', figureSpans(DEMON, DEMON_MASK, rows)) : null}
      </Box>
    )
  })
}
