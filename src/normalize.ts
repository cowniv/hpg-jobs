import { TAB, type Brand, type Problem, type RawLine } from './types.ts'

/**
 * Turns raw sheet lines into clean, public-safe jobs - and says exactly what it
 * fixed or skipped. Three outcomes per row (see PLAN.md):
 *
 *   fixed    - silently corrected (spaces, case, "56.0", known typos, broken ñ)
 *   skipped  - not shown, reported (openings not a number, absurd count,
 *              unknown status, a client name in public text)
 *   held     - a whole tab kept at its last good version (handled in read.ts /
 *              feed.ts, not here)
 *
 * Nothing a recruiter types reaches the site unchecked.
 */

/** A job as the sites see it, before the written copy is merged in. */
export interface CleanJob {
  id: string
  brand: Brand
  title: string
  /** Lower-case key the written copy is matched on. */
  titleKey: string
  areas: string[]
  jobType: string
  /** Openings still to fill. null when the sheet does not say clearly (shown as "Multiple openings"). */
  openings: number | null
  /** ISO date the request was made, or null. */
  postedAt: string | null
  /** The sheet's own duties text, tidied - only used when there is no written copy. */
  sheetDuties: string
}

const OPEN = new Set(['ACTIVE'])
const CLOSED = new Set(['', 'ON HOLD', 'ONHOLD', 'INACTIVE', 'CLOSED', 'FILLED', 'CANCELLED', 'CANCELED', 'DONE', 'COMPLETED'])
/** More than this many openings on one line is almost certainly a typo. */
export const MAX_OPENINGS = 2000

const JOB_TYPES: Record<string, string> = {
  PROBATIONARY: 'Full-time (probationary)',
  'PROJECT BASED': 'Project-based',
  'PROJECT-BASED': 'Project-based',
  'ON CALL': 'On-call',
  'ON-CALL': 'On-call',
  CONTRACTUAL: 'Contractual',
  SEASONAL: 'Seasonal',
  'PART TIME': 'Part-time',
  'PART-TIME': 'Part-time',
  'FULL TIME': 'Full-time',
  'FULL-TIME': 'Full-time',
  REGULAR: 'Full-time',
}

/** Known misspellings seen in the sheet. Lower-case keys. */
const TYPOS: Record<string, string> = {
  meyacuayan: 'Meycauayan',
  mantenance: 'Maintenance',
  backroon: 'Backroom',
}

/** Words kept upper-case when a title or area is converted from ALL CAPS. */
const ACRONYMS = new Set(['HR', 'SAQ', 'FTTH', 'NC', 'II', 'III', 'IT', 'QA', 'QC', 'OSP', 'POS', 'CSR', 'HO', 'NCR', 'BPO', 'SPX'])
const SMALL = new Set(['de', 'del', 'la', 'las', 'los', 'of', 'and', 'w/', 'ng', 'sa'])

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/(\s+|\/|-|\()/)
    .map((w, i) => {
      if (!w.trim() || /^[\s/(-]+$/.test(w)) return w
      if (ACRONYMS.has(w.toUpperCase())) return w.toUpperCase()
      if (i > 0 && SMALL.has(w)) return w
      return w.charAt(0).toUpperCase() + w.slice(1)
    })
    .join('')
}

const tidy = (s: string) => s.replace(/ /g, ' ').replace(/[ \t]+/g, ' ').trim()

/** Undoes the sheet's broken "ñ" and applies the known-typo list word by word. */
function repairWords(s: string, fixed: (m: string) => void): string {
  let out = s
  if (out.includes('�')) {
    out = out.replace(/�/g, 'ñ')
    fixed(`a broken character was restored as "ñ" ("${out}")`)
  }
  return out.replace(/[A-Za-z]+/g, (w) => {
    const t = TYPOS[w.toLowerCase()]
    if (!t) return w
    fixed(`"${w}" corrected to "${t}"`)
    return t
  })
}

function cleanArea(raw: string, fixed: (m: string) => void): string {
  let a = tidy(raw)
  if (!a || /^n\/?a$/i.test(a)) return ''
  const caps = a === a.toUpperCase() // decided BEFORE repair: a restored "ñ" is lower-case
  a = repairWords(a, fixed)
  return caps ? titleCase(a) : a
}

function cleanTitle(raw: string, fixed: (m: string) => void): string {
  let t = tidy(raw).replace(/\s*\.\s*$/, '')
  const caps = t === t.toUpperCase()
  t = repairWords(t, fixed)
  return caps ? titleCase(t) : t.charAt(0).toUpperCase() + t.slice(1)
}

/** "56", " 56 ", "56.0", "1,080" -> number; anything else -> NaN. */
export function parseCount(raw: string): number {
  const s = raw.replace(/,/g, '').trim()
  if (!/^-?\d+(\.\d+)?$/.test(s)) return Number.NaN
  return Number(s)
}

/** Tidies the sheet's duties text into plain sentences, one per line. */
export function tidyDuties(raw: string): string {
  return raw
    .split(/\n|(?:^|\s)[•·*-]\s+|\s{3,}/)
    .map((l) => l.replace(/^[\s.•·*-]+/, '').trim())
    .filter((l) => l.length > 3)
    .map((l) => l.charAt(0).toUpperCase() + l.slice(1).replace(/\s*\.?$/, '.'))
    .join('\n')
}

export const slug = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export function titleKey(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').replace(/\s*w\/\s*/g, ' with ').trim()
}

/** True if text contains a client name from the sheet's CLIENTS column (word-boundary, case-insensitive). */
function leaksClient(text: string, clients: Set<string>): string | null {
  const t = text.toLowerCase()
  for (const c of clients) {
    const n = c.toLowerCase().trim()
    if (n.length < 3) continue
    const re = new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`)
    if (re.test(t)) return c
  }
  return null
}

/** Masks every client name in a report line. Problem messages quote raw cells and land in public Action logs. */
function redactClients(text: string, clients: Set<string>): string {
  let out = text
  for (const c of clients) {
    const n = c.trim()
    if (n.length < 3) continue
    out = out.replace(new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[^a-z0-9]|$)`, 'gi'), '$1[client name]')
  }
  return out
}

interface Line {
  brand: Brand
  row: number
  blockRow: number
  title: string
  area: string
  jobType: string
  openings: number | null
  postedAt: string | null
  duties: string
}

export interface NormalizeResult {
  jobs: CleanJob[]
  problems: Problem[]
}

export function normalize(raw: RawLine[], clients: Set<string>): NormalizeResult {
  const problems: Problem[] = []
  const lines: Line[] = []

  // group raw lines by request block
  const blocks = new Map<string, RawLine[]>()
  for (const l of raw) {
    const k = `${l.brand}:${l.blockRow}`
    blocks.set(k, [...(blocks.get(k) ?? []), l])
  }

  for (const block of blocks.values()) {
    const head = block[0]!
    const { brand } = head
    const where = `${TAB[brand]} tab, row ${head.blockRow}`
    const status = tidy(head.status).toUpperCase()
    if (!OPEN.has(status)) {
      if (!CLOSED.has(status)) {
        problems.push({ level: 'skipped', brand, row: head.blockRow, title: tidy(head.title), key: `bad-status|${brand}|${titleKey(head.title)}|${tidy(head.status)}`, message: `${where} (${tidy(head.title)}): MR STATUS is "${tidy(head.status)}", which the site doesn't recognise. Use ACTIVE, ON HOLD or INACTIVE. Not shown on the site.` })
      }
      continue
    }

    const fixedAt = (row: number, title: string) => (m: string) => problems.push({ level: 'fixed', brand, row, title, message: `${TAB[brand]} tab, row ${row}: ${m}.` })

    // openings for the whole block
    const remaining = parseCount(head.remaining)
    if (head.remaining && Number.isNaN(remaining)) {
      problems.push({ level: 'skipped', brand, row: head.blockRow, title: tidy(head.title), key: `remaining-nan|${brand}|${titleKey(head.title)}|${head.remaining}`, message: `${where} (${tidy(head.title)}): openings left is "${head.remaining}", which isn't a number. Not shown on the site until it is.` })
      continue
    }
    if (!Number.isNaN(remaining) && remaining <= 0) continue // fully filled: closed, not a problem
    if (remaining > MAX_OPENINGS) {
      problems.push({ level: 'skipped', brand, row: head.blockRow, title: tidy(head.title), key: `remaining-big|${brand}|${titleKey(head.title)}`, message: `${where} (${tidy(head.title)}): ${remaining} openings looks like a typo (more than ${MAX_OPENINGS}). Not shown on the site.` })
      continue
    }

    const jobTypeRaw = tidy(head.jobType).toUpperCase()
    const jobType = JOB_TYPES[jobTypeRaw] ?? (jobTypeRaw ? titleCase(jobTypeRaw) : '')
    if (jobTypeRaw && !JOB_TYPES[jobTypeRaw]) fixedAt(head.blockRow, head.title)(`job type "${head.jobType}" isn't one of the usual ones; shown as "${jobType}"`)

    const postedAt = /^\d{4}-\d{2}-\d{2}$/.test(head.requested) ? head.requested : null

    // split title cells that pack several roles ("Operations Assistant      Sales Account Specialist")
    const expanded: Array<{ l: RawLine; title: string; packed: boolean }> = []
    for (const l of block) {
      const parts = l.title.split(/\n|\s{3,}/).map((p) => p.trim()).filter(Boolean)
      for (const p of parts) expanded.push({ l, title: p, packed: parts.length > 1 })
    }
    const distinctTitles = new Set(expanded.map((e) => titleKey(e.title)))
    const packedBlock = expanded.some((e) => e.packed)

    let skipBlock = false
    const perLine: Line[] = []
    for (const { l, title: t0, packed } of expanded) {
      const title = cleanTitle(t0, fixedAt(l.row, t0))
      const area = cleanArea(l.area, fixedAt(l.row, title))
      let openings: number | null
      if (packed) openings = null
      else if (distinctTitles.size === 1) openings = null // set once per block below
      else {
        const b = parseCount(l.breakdown)
        if (l.breakdown && Number.isNaN(b)) {
          problems.push({ level: 'skipped', brand, row: l.row, title, key: `breakdown-nan|${brand}|${titleKey(title)}|${l.breakdown}`, message: `${TAB[brand]} tab, row ${l.row} (${title}): MR BREAKDOWN is "${l.breakdown}", which isn't a number. That line isn't shown.` })
          continue
        }
        openings = Number.isNaN(b) ? null : b
        if (openings != null && openings > MAX_OPENINGS) {
          problems.push({ level: 'skipped', brand, row: l.row, title, key: `breakdown-big|${brand}|${titleKey(title)}`, message: `${TAB[brand]} tab, row ${l.row} (${title}): ${openings} openings looks like a typo. That line isn't shown.` })
          continue
        }
        if (openings != null && openings <= 0) continue
      }
      for (const text of [title, area]) {
        const hit = leaksClient(text, clients)
        if (hit) {
          // The message names the row and column, never the text or the client: problem
          // reports reach the (public) Action log and the alert email.
          problems.push({ level: 'skipped', brand, row: l.row, title: text === title ? undefined : title, key: `client-name|${brand}|${text === title ? 'title' : `area|${titleKey(title)}`}`, message: `${TAB[brand]} tab, row ${l.row}: the ${text === title ? 'JOB TITLE' : 'AREA/TEAM'} cell contains a client's name, which must never appear on the site. That line isn't shown.` })
          skipBlock = text === title
        }
      }
      if (skipBlock) break
      if (leaksClient(area, clients)) continue
      perLine.push({ brand, row: l.row, blockRow: l.blockRow, title, area, jobType, openings, postedAt, duties: l.duties })
    }
    if (skipBlock) continue

    // single-title block: the block's openings-left is the truth, not the breakdown
    if (distinctTitles.size === 1 && !packedBlock && perLine.length) {
      const sum = perLine.reduce((n, l) => n + (Number(parseCount(block.find((r) => r.row === l.row)?.breakdown ?? '')) || 0), 0)
      const total = Number.isNaN(remaining) ? (sum || null) : remaining
      perLine.forEach((l, i) => (l.openings = i === 0 ? total : 0))
    }
    lines.push(...perLine)
  }

  // merge lines into one job per brand + title
  const jobs = new Map<string, CleanJob>()
  for (const l of lines) {
    const key = `${l.brand}:${titleKey(l.title)}`
    let j = jobs.get(key)
    if (!j) {
      j = { id: `${l.brand}-${slug(l.title)}`, brand: l.brand, title: l.title, titleKey: titleKey(l.title), areas: [], jobType: l.jobType, openings: 0, postedAt: l.postedAt, sheetDuties: '' }
      jobs.set(key, j)
    }
    if (l.area && !j.areas.includes(l.area)) j.areas.push(l.area)
    if (l.openings == null) j.openings = null
    else if (j.openings != null) j.openings += l.openings
    if (l.postedAt && (!j.postedAt || l.postedAt > j.postedAt)) j.postedAt = l.postedAt
    if (!j.sheetDuties && l.duties) {
      const leak = leaksClient(l.duties, clients)
      j.sheetDuties = leak ? '' : tidyDuties(l.duties)
    }
  }
  const out = [...jobs.values()].filter((j) => j.openings !== 0)
  out.forEach((j) => j.areas.sort((a, b) => a.localeCompare(b)))
  const safe = problems.map((p) => ({ ...p, message: redactClients(p.message, clients), ...(p.title ? { title: redactClients(p.title, clients) } : {}), ...(p.key ? { key: redactClients(p.key, clients) } : {}) }))
  return { jobs: out.sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? '') || a.title.localeCompare(b.title)), problems: safe }
}
