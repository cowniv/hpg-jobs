import type { CopyIndex } from './copy.ts'
import { slug, type CleanJob } from './normalize.ts'
import { BRANDS, TAB, type Brand, type Problem } from './types.ts'

/**
 * Builds feed/jobs.json - the ONLY thing the sites read. Everything in it is
 * public by design: no client, store, recruiter, rate or sheet note can be here,
 * because none of them is ever read past read.ts / normalize.ts.
 *
 * Two safety nets live here:
 * - HOLD: a brand whose tab could not be trusted keeps its last good jobs.
 * - BIG DROP: a brand losing more than half its jobs in one sync is assumed to
 *   be an accident (a filter left on, rows deleted) and is held too, until a
 *   person confirms it with ACCEPT_DROP.
 */

export const SCHEMA = 1
export const OTHER = 'Other'
/** The big-drop guard only applies once a brand has at least this many jobs. */
export const DROP_MIN = 4

export interface PublicJob {
  id: string
  brand: Brand
  title: string
  category: string
  areas: string[]
  jobType: string
  /** null = "Multiple openings". */
  openings: number | null
  postedAt: string | null
  summary: string
  responsibilities: string[]
  lookingFor: string[]
}

export interface BrandState {
  /** live = from this sync; held = last good list kept (see the report for why). */
  state: 'live' | 'held'
  jobs: number
  /** When this brand's list last came live from the sheet. */
  updatedAt: string | null
}

export interface Feed {
  schema: typeof SCHEMA
  generatedAt: string
  brands: Record<Brand, BrandState>
  categories: string[]
  jobs: PublicJob[]
}

export interface BuildInput {
  jobs: CleanJob[]
  held: Brand[]
  copy: CopyIndex
  previous: Feed | null
  now: string
  /** Brands whose big drop a person has confirmed. */
  acceptDrop?: Brand[]
}

export interface BuildResult {
  feed: Feed
  problems: Problem[]
  /** Sheet titles with no written post yet - they publish with the sheet's duties. */
  needsCopy: Array<{ brand: Brand; title: string }>
}

export function buildFeed(input: BuildInput): BuildResult {
  const { copy, previous, now } = input
  const problems: Problem[] = []
  const needsCopy: BuildResult['needsCopy'] = []

  // 1. sheet jobs -> public jobs, merging titles that share one written post
  //    (Repacker + Warehouseman are both "Warehouse Staff")
  const fresh = new Map<string, PublicJob>()
  for (const j of input.jobs) {
    const role = copy.find(j.title)
    if (!role) needsCopy.push({ brand: j.brand, title: j.title })
    const title = role?.title ?? j.title
    const id = `${j.brand}-${slug(title)}`
    const prev = fresh.get(id)
    if (prev) {
      for (const a of j.areas) if (!prev.areas.includes(a)) prev.areas.push(a)
      prev.areas.sort((a, b) => a.localeCompare(b))
      prev.openings = prev.openings == null || j.openings == null ? null : prev.openings + j.openings
      if (j.postedAt && (!prev.postedAt || j.postedAt > prev.postedAt)) prev.postedAt = j.postedAt
      continue
    }
    const duties = j.sheetDuties.split('\n').filter(Boolean)
    fresh.set(id, {
      id,
      brand: j.brand,
      title,
      category: role?.category ?? OTHER,
      areas: [...j.areas],
      jobType: j.jobType,
      openings: j.openings,
      postedAt: j.postedAt,
      summary: role?.summary ?? '',
      responsibilities: role?.responsibilities ?? duties.slice(0, 8),
      lookingFor: role?.lookingFor ?? [],
    })
  }

  // 2. per brand: live, held (tab untrusted) or held (big drop)
  const brands = {} as Record<Brand, BrandState>
  const jobs: PublicJob[] = []
  for (const brand of BRANDS) {
    const mine = [...fresh.values()].filter((j) => j.brand === brand)
    const before = previous?.jobs.filter((j) => j.brand === brand) ?? []
    const prevState = previous?.brands[brand]
    const keep = (why?: string) => {
      if (why) problems.push({ level: 'held', brand, message: why })
      brands[brand] = { state: 'held', jobs: before.length, updatedAt: prevState?.updatedAt ?? null }
      jobs.push(...before)
    }
    if (input.held.includes(brand)) keep() // read.ts already said why
    else if (before.length >= DROP_MIN && mine.length < before.length / 2 && !input.acceptDrop?.includes(brand)) {
      keep(`${TAB[brand]}: open roles fell from ${before.length} to ${mine.length} in one update. That is usually an accident (rows deleted, a filter or a status changed by mistake), so the site still shows the previous ${before.length}. If the drop is real, run the sync again with "accept drop" for ${TAB[brand]}.`)
    } else {
      brands[brand] = { state: 'live', jobs: mine.length, updatedAt: now }
      jobs.push(...mine)
    }
  }

  const used = new Set(jobs.map((j) => j.category))
  const categories = [...copy.categories, OTHER].filter((c) => used.has(c))
  jobs.sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? '') || a.title.localeCompare(b.title) || a.brand.localeCompare(b.brand))
  return { feed: { schema: SCHEMA, generatedAt: now, brands, categories, jobs }, problems, needsCopy }
}

/** True when two feeds differ in anything but their timestamps - the Action commits only then. */
export function sameContent(a: Feed | null, b: Feed): boolean {
  if (!a) return false
  const strip = (f: Feed) => JSON.stringify({ ...f, generatedAt: '', brands: Object.fromEntries(Object.entries(f.brands).map(([k, v]) => [k, { ...v, updatedAt: '' }])) })
  return strip(a) === strip(b)
}

/** Shape check for a feed read back from disk (or by a site). Returns why it's unusable, or null. */
export function feedProblem(x: unknown): string | null {
  const f = x as Partial<Feed>
  if (!f || typeof f !== 'object') return 'not an object'
  if (f.schema !== SCHEMA) return `schema ${String(f.schema)}, expected ${SCHEMA}`
  if (!Array.isArray(f.jobs) || !Array.isArray(f.categories) || !f.brands) return 'missing jobs, categories or brands'
  for (const j of f.jobs) {
    if (typeof j.id !== 'string' || typeof j.title !== 'string' || !BRANDS.includes(j.brand) || !Array.isArray(j.areas)) return `bad job ${JSON.stringify(j).slice(0, 80)}`
  }
  return null
}
