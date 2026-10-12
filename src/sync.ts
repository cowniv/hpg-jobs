import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadCopy, type CopyFile } from './copy.ts'
import { buildFeed, feedProblem, sameContent, type Feed } from './feed.ts'
import { normalize } from './normalize.ts'
import { readWorkbook } from './read.ts'
import { BRANDS, TAB, type Brand, type Problem } from './types.ts'

/**
 * npm run sync
 *
 *   MR_SHEET_ID   the Google Sheet id (an Actions secret - never commit it)
 *   MR_XLSX       or: a local .xlsx to read instead (testing)
 *   ACCEPT_DROP   comma-separated brands whose big drop a person has confirmed, e.g. "dssi"
 *
 * Writes feed/jobs.json only when the jobs actually changed, and report.md
 * (gitignored) for the alert step. A failed download changes nothing: the
 * sites keep reading the last good feed.
 */

const FEED = 'feed/jobs.json'
const REPORT = 'report.md'

async function source(): Promise<Buffer> {
  if (process.env.MR_XLSX) return readFileSync(process.env.MR_XLSX)
  const id = process.env.MR_SHEET_ID
  if (!id) throw new Error('Set MR_SHEET_ID (or MR_XLSX for a local file).')
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/export?format=xlsx`, { redirect: 'follow' })
  const type = res.headers.get('content-type') ?? ''
  // a sheet that is no longer shared answers 200 with a Google sign-in PAGE, not an error
  if (!res.ok || !type.includes('spreadsheetml')) throw new Error(`Could not download the MR sheet (HTTP ${res.status}, ${type || 'no type'}). Is it still shared "anyone with the link", or has the robot lost access?`)
  return Buffer.from(await res.arrayBuffer())
}

function previousFeed(): Feed | null {
  if (!existsSync(FEED)) return null
  const f = JSON.parse(readFileSync(FEED, 'utf8')) as unknown
  const why = feedProblem(f)
  if (why) throw new Error(`${FEED} is damaged (${why}). Restore it from git before syncing.`)
  return f as Feed
}

function report(problems: Problem[], needsCopy: Array<{ brand: Brand; title: string }>, feed: Feed, changed: boolean): string {
  const out = [`# MR sheet sync - ${feed.generatedAt}`, '', changed ? 'The site job list was updated.' : 'No change to the site job list.', '']
  out.push('| Company | Open roles on the site | Status |', '|---|---|---|')
  for (const b of BRANDS) out.push(`| ${TAB[b]} | ${feed.brands[b].jobs} | ${feed.brands[b].state === 'live' ? 'up to date' : '**held - showing the last good list**'} |`)
  const section = (head: string, ps: Problem[]) => ps.length && out.push('', `## ${head}`, '', ...ps.map((p) => `- ${p.message}`))
  section('Held back - needs attention', problems.filter((p) => p.level === 'held'))
  section('Not shown on the site - please fix in the sheet', problems.filter((p) => p.level === 'skipped'))
  section('Fixed automatically (for information)', problems.filter((p) => p.level === 'fixed'))
  if (needsCopy.length) out.push('', '## Roles with no written job post yet (developer)', '', ...needsCopy.map((n) => `- ${TAB[n.brand]}: ${n.title} - showing the sheet's own duties`))
  return out.join('\n') + '\n'
}

async function main() {
  const copy = loadCopy(JSON.parse(readFileSync('copy/roles.json', 'utf8')) as CopyFile)
  const previous = previousFeed()
  const read = await readWorkbook(await source())
  const norm = normalize(read.lines, read.clientNames)
  const acceptDrop = (process.env.ACCEPT_DROP ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s): s is Brand => (BRANDS as readonly string[]).includes(s))
  const built = buildFeed({ jobs: norm.jobs, held: read.held, copy, previous, now: new Date().toISOString(), acceptDrop })
  const problems = [...read.problems, ...norm.problems, ...built.problems]

  const changed = !sameContent(previous, built.feed)
  if (changed) {
    mkdirSync(dirname(FEED), { recursive: true })
    writeFileSync(FEED, JSON.stringify(built.feed, null, 2) + '\n')
  }
  const md = report(problems, built.needsCopy, built.feed, changed)
  writeFileSync(REPORT, md)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md)
  if (process.env.GITHUB_OUTPUT) {
    const needsAttention = problems.some((p) => p.level !== 'fixed')
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\nattention=${needsAttention}\n`)
  }
  console.log(md)
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
