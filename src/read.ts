import ExcelJS from 'exceljs'
import { BRANDS, TAB, type Brand, type Problem, type RawLine } from './types.ts'

/**
 * Reads the MR sheet's xlsx export into raw lines, one per sheet row inside an
 * ACTIVE-or-not request block. No judgement happens here beyond structure:
 * validation and clean-up are normalize.ts's job.
 *
 * HOW THE SHEET IS BUILT (measured 2026-10-12):
 * - A request is a BLOCK of rows; its MR STATUS cell is merged across them
 *   (or is a single row). Most columns are merged the same way.
 * - Inside a block each row is a line: a job title, a count (MR BREAKDOWN) and
 *   an area. Titles and areas are sometimes merged, sometimes left blank to mean
 *   "same as above" - so blanks fill down WITHIN the block, never across blocks.
 * - Columns differ by tab (DSIC has AGING/DAYS and no TOTAL MR REMAINING), so
 *   every column is found by its HEADER NAME, not its letter.
 */

type Field = 'client' | 'title' | 'duties' | 'breakdown' | 'need' | 'area' | 'jobType' | 'status' | 'requested' | 'remaining'

/** Header text (normalised) -> field. Anything not listed is ignored on purpose. */
const HEADERS: Record<string, Field> = {
  'JOB TITLE': 'title',
  'JOB DESCRIPTIONS': 'duties',
  'JOB DESCRIPTION': 'duties',
  'MR BREAKDOWN': 'breakdown',
  'NEED TO BE FILLED': 'need',
  'AREA/TEAM': 'area',
  'JOB TYPE': 'jobType',
  'MR STATUS': 'status',
  'REQUEST DATE': 'requested',
  'TOTAL MR REMAINING': 'remaining',
  // read ONLY to build a blocklist so a client name can never reach the feed
  CLIENTS: 'client',
}

/** A tab can't be trusted without these. Missing any => the whole tab is held back. */
const REQUIRED: Field[] = ['title', 'status', 'area', 'jobType']

export function normHeader(h: string): string {
  return h.split('\n')[0]!.replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim().toUpperCase()
}

/** Plain text of any exceljs cell value (rich text, formulas, hyperlinks, dates). */
export function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('')
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue)
    if ('text' in v) return String(v.text)
    if ('error' in v) return ''
  }
  return String(v)
}

interface Range { r1: number; c1: number; r2: number; c2: number }

function parseRange(s: string): Range {
  const m = s.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/)
  if (!m) throw new Error(`bad merge range ${s}`)
  const col = (l: string) => [...l].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)
  return { c1: col(m[1]!), r1: Number(m[2]), c2: col(m[3]!), r2: Number(m[4]) }
}

export interface ReadResult {
  lines: RawLine[]
  problems: Problem[]
  /** Brands whose tab was unreadable or missing required columns - the feed keeps their last good data. */
  held: Brand[]
  /** Every value in the CLIENTS column. Internal - used only to block leaks, never output. */
  clientNames: Set<string>
}

export async function readWorkbook(buf: ArrayBuffer | Buffer): Promise<ReadResult> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as ArrayBuffer)
  const lines: RawLine[] = []
  const problems: Problem[] = []
  const held: Brand[] = []
  const clientNames = new Set<string>()

  for (const brand of BRANDS) {
    const ws = wb.getWorksheet(TAB[brand])
    if (!ws) {
      held.push(brand)
      problems.push({ level: 'held', brand, message: `The "${TAB[brand]}" tab is missing from the sheet (renamed or deleted?). Showing the last good list for ${TAB[brand]}.` })
      continue
    }

    // column index for each field, by header name
    const col: Partial<Record<Field, number>> = {}
    ws.getRow(1).eachCell({ includeEmpty: false }, (cell, c) => {
      const f = HEADERS[normHeader(cellText(cell.value))]
      if (f && col[f] == null) col[f] = c
    })
    if (col.remaining == null && col.need != null) col.remaining = col.need
    const missing = REQUIRED.filter((f) => col[f] == null)
    if (col.remaining == null) missing.push('remaining')
    if (missing.length) {
      held.push(brand)
      problems.push({
        level: 'held',
        brand,
        message: `The ${TAB[brand]} tab is missing column(s) the site needs: ${missing.map(niceField).join(', ')}. A column may have been renamed or deleted. Showing the last good list for ${TAB[brand]} until it is fixed.`,
      })
      continue
    }

    const merges = ((ws.model as { merges?: string[] }).merges ?? []).map(parseRange)
    const statusCol = col.status!
    const blockOf = (row: number): [number, number] => {
      const m = merges.find((g) => g.c1 <= statusCol && statusCol <= g.c2 && g.r1 <= row && row <= g.r2)
      return m ? [m.r1, m.r2] : [row, row]
    }
    const get = (row: number, f: Field) => (col[f] ? cellText(ws.getCell(row, col[f]!).value).trim() : '')
    // A merged cell reads the same value on every row it spans. For a COUNT that
    // would add it up once per row (DSSI's 70 drivers became 216), so counts are
    // taken from the merge's first row only.
    const own = (row: number, f: Field) => {
      if (!col[f]) return ''
      const cell = ws.getCell(row, col[f]!)
      return cell.isMerged && cell.master.address !== cell.address ? '' : cellText(cell.value).trim()
    }

    const last = ws.actualRowCount > 0 ? ws.lastRow?.number ?? 1 : 1
    let row = 2
    while (row <= last) {
      const [b1, b2] = blockOf(row)
      const status = get(b1, 'status')
      const client = get(b1, 'client')
      if (client) for (const c of client.split(/[\n/,]+/)) if (c.trim().length >= 3) clientNames.add(c.trim())
      // a block needs a status; a status-less, title-less row is just spacing
      const rows: number[] = []
      for (let r = b1; r <= b2; r++) rows.push(r)
      const hasAny = rows.some((r) => get(r, 'title') || get(r, 'breakdown'))
      if (status || hasAny) {
        let title = ''
        let area = ''
        const blockLines: RawLine[] = []
        for (const r of rows) {
          title = get(r, 'title') || title
          area = get(r, 'area') || area
          if (!title) continue
          blockLines.push({
            brand,
            row: r,
            blockRow: b1,
            title,
            area,
            jobType: get(r, 'jobType') || get(b1, 'jobType'),
            status,
            duties: get(r, 'duties') || get(b1, 'duties'),
            breakdown: own(r, 'breakdown'),
            remaining: get(b1, 'remaining'),
            requested: get(b1, 'requested'),
            blockTitles: 0,
          })
        }
        const distinct = new Set(blockLines.map((l) => l.title.toLowerCase()))
        for (const l of blockLines) l.blockTitles = distinct.size
        lines.push(...blockLines)
      }
      row = b2 + 1
    }
  }
  return { lines, problems, held, clientNames }
}

function niceField(f: string): string {
  return { title: 'JOB TITLE', status: 'MR STATUS', area: 'AREA/TEAM', jobType: 'JOB TYPE', remaining: 'TOTAL MR REMAINING (or NEED TO BE FILLED)' }[f] ?? f
}
