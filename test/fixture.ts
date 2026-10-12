import ExcelJS from 'exceljs'

/**
 * Builds a small MR-sheet-shaped workbook for tests: same headers, merged
 * MR STATUS / count cells, and blanks-mean-same-as-above, as the real one.
 */

export const HEADER = ['CLIENTS', 'JOB TITLE', 'JOB DESCRIPTIONS', 'QUALIFICATIONS', 'MR BREAKDOWN', 'AREA/TEAM', 'JOB TYPE', 'MR STATUS', 'REQUEST DATE', 'TOTAL MR REMAINING']

/** One request block. `lines` are [title, breakdown, area]; '' = blank cell (same as above). */
export interface Block {
  client?: string
  status: string
  jobType?: string
  remaining?: string | number
  requested?: string
  duties?: string
  lines: Array<[string, string | number, string]>
}

export async function workbook(tabs: Record<string, { header?: string[]; blocks: Block[] }>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  for (const [name, { header = HEADER, blocks }] of Object.entries(tabs)) {
    const ws = wb.addWorksheet(name)
    ws.addRow(header)
    const c = (h: string) => header.indexOf(h) + 1
    let r = 2
    for (const b of blocks) {
      const r1 = r
      for (const [title, breakdown, area] of b.lines) {
        const row = ws.getRow(r)
        if (title && c('JOB TITLE')) row.getCell(c('JOB TITLE')).value = title
        if (breakdown !== '' && c('MR BREAKDOWN')) row.getCell(c('MR BREAKDOWN')).value = breakdown
        if (area && c('AREA/TEAM')) row.getCell(c('AREA/TEAM')).value = area
        r++
      }
      const r2 = r - 1
      const put = (h: string, v: string | number | undefined) => {
        if (!c(h) || v === undefined) return
        ws.getCell(r1, c(h)).value = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v) : v
        if (r2 > r1) ws.mergeCells(r1, c(h), r2, c(h))
      }
      put('CLIENTS', b.client ?? 'Acme Retail Corp')
      put('MR STATUS', b.status)
      put('JOB TYPE', b.jobType ?? 'PROBATIONARY')
      put('TOTAL MR REMAINING', b.remaining)
      put('REQUEST DATE', b.requested ?? '2026-10-01')
      put('JOB DESCRIPTIONS', b.duties ?? 'Pack and sort items.')
      put('QUALIFICATIONS', 'Male, 18-30 years old, at least 5\'5"')
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}
