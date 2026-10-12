import { titleKey } from './normalize.ts'

/**
 * The written job posts in copy/roles.json. The sheet supplies only the live
 * facts (open or not, openings, area, type, date); the words come from here, so
 * a recruiter's typo or a discriminatory QUALIFICATIONS cell can never reach a
 * job post.
 */

export interface Role {
  match: string[]
  title: string
  category: string
  summary: string
  responsibilities: string[]
  lookingFor: string[]
}

export interface CopyFile {
  categories: string[]
  roles: Role[]
}

/** Words a 'lookingFor' line must never contain (RA 10911, and fair hiring generally). */
const BANNED = /\b(age|years old|y\/o|yrs old|male|female|height|5'|cm tall|single|married|pleasing personality|good-looking|physically attractive)\b/i

export interface CopyIndex {
  categories: string[]
  find(title: string): Role | undefined
}

/** Checks the file and builds the lookup. Throws on a broken file - a bad copy edit must fail the run, not ship. */
export function loadCopy(file: CopyFile): CopyIndex {
  const errors: string[] = []
  const byKey = new Map<string, Role>()
  const cats = new Set(file.categories)
  for (const r of file.roles) {
    if (!r.title || !r.summary) errors.push(`role "${r.title || '?'}" needs a title and a summary`)
    if (!cats.has(r.category)) errors.push(`role "${r.title}" has category "${r.category}", which isn't in "categories"`)
    if (!r.responsibilities?.length || !r.lookingFor?.length) errors.push(`role "${r.title}" needs responsibilities and lookingFor`)
    for (const line of [...(r.lookingFor ?? []), ...(r.responsibilities ?? []), r.summary]) {
      if (BANNED.test(line)) errors.push(`role "${r.title}": "${line}" mentions age, sex, height, looks or civil status - not allowed`)
    }
    for (const m of [r.title, ...r.match]) {
      const k = titleKey(m)
      const prev = byKey.get(k)
      if (prev && prev !== r) errors.push(`"${m}" is matched by both "${prev.title}" and "${r.title}"`)
      byKey.set(k, r)
    }
  }
  if (errors.length) throw new Error(`copy/roles.json has problems:\n- ${errors.join('\n- ')}`)
  return { categories: file.categories, find: (title) => byKey.get(titleKey(title)) }
}
