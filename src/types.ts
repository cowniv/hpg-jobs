/** The four brand tabs in the MR sheet. PORTAL has none. */
export const BRANDS = ['helpro', 'dssi', 'dsic', 'gr8staff'] as const
export type Brand = (typeof BRANDS)[number]

/** Tab name in the sheet for each brand. */
export const TAB: Record<Brand, string> = {
  helpro: 'HELPRO',
  dssi: 'DSSI',
  dsic: 'DSIC',
  gr8staff: 'GR8STAFF',
}

/**
 * One row of a request block, exactly as read - before any validation.
 * Internal-only fields (client, recruiter, rates, notes, qualifications) are
 * deliberately NOT read at all, so they cannot leak into the feed by mistake.
 */
export interface RawLine {
  brand: Brand
  /** 1-based sheet row, for problem reports ("DSIC tab, row 14"). */
  row: number
  /** First row of the request block this line belongs to. */
  blockRow: number
  title: string
  area: string
  jobType: string
  status: string
  duties: string
  /** This line's own count (MR BREAKDOWN). */
  breakdown: string
  /** The block's openings left (TOTAL MR REMAINING, or NEED TO BE FILLED on tabs without it). */
  remaining: string
  requested: string
  /** How many distinct job titles share this block. */
  blockTitles: number
}

/** A problem found while reading or validating, in plain language for the alert email. */
export interface Problem {
  level: 'fixed' | 'skipped' | 'held'
  brand: Brand
  row?: number
  title?: string
  /**
   * What the problem IS, without the row number or a live count, so the alert
   * fingerprint (alert.ts) does not change when a row is inserted above it or a
   * held tab is edited. Falls back to `message` when unset.
   */
  key?: string
  message: string
}
