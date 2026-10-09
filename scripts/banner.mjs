/* global process, console */
/**
 * Startup banner for `npm run dev`: the Vortaq name in block letters in the terminal,
 * in the app's cyan-to-violet gradient. Plain text when the output is not a
 * terminal or NO_COLOR is set; never fails the dev command.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const ART = [
  '  ██╗   ██╗ ██████╗ ██████╗ ████████╗ █████╗  ██████╗ ',
  '  ██║   ██║██╔═══██╗██╔══██╗╚══██╔══╝██╔══██╗██╔═══██╗',
  '  ██║   ██║██║   ██║██████╔╝   ██║   ███████║██║   ██║',
  '  ╚██╗ ██╔╝██║   ██║██╔══██╗   ██║   ██╔══██║██║▄▄ ██║',
  '   ╚████╔╝ ╚██████╔╝██║  ██║   ██║   ██║  ██║╚██████╔╝',
  '    ╚═══╝   ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝ ╚══▀▀═╝ '
]

function version() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? ''
  } catch {
    return ''
  }
}

/** Cyan (#22d3ee) to violet (#8b5cf6), by column. */
function gradient(line, width) {
  const from = [0x22, 0xd3, 0xee]
  const to = [0x8b, 0x5c, 0xf6]
  return [...line]
    .map((ch, i) => {
      if (ch === ' ') return ch
      const t = width > 1 ? i / (width - 1) : 0
      const [r, g, b] = from.map((c, k) => Math.round(c + (to[k] - c) * t))
      return `\x1b[38;2;${r};${g};${b}m${ch}`
    })
    .join('')
    .concat('\x1b[0m')
}

try {
  const color = process.stdout.isTTY && !process.env.NO_COLOR
  const width = Math.max(...ART.map((l) => [...l].length))
  const v = version()
  const lines = ART.map((l) => (color ? gradient(l, width) : l))
  const dim = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s)
  console.log(
    ['', ...lines, '', `  ${dim(`Vortaq ${v} · modo desarrollo · iniciando…`)}`, ''].join('\n')
  )
} catch {
  /* the banner is decoration only */
}
