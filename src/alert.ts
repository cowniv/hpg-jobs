import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { TAB, type Brand, type Problem } from './types.ts'

/**
 * Alert emails (PLAN.md task 10). After a sync, a plain-language report goes to
 * the people who can fix the sheet - but only when something CHANGED, so a
 * problem nobody has fixed yet does not arrive every 30 minutes.
 *
 * Three audiences, each tracked on its own in feed/alert-state.json:
 *
 *   recruiters  ALERT_TO       what keeps roles off the sites (held + skipped)
 *   team        ALERT_TO_TEAM  the same, plus roles with no written post, fixes
 *                              made automatically, and a link to the run
 *   failure     ALERT_TO_TEAM  the sync itself could not run (alert-failure.ts)
 *
 * Per audience: email when the list's fingerprint changes; a reminder at most
 * once every 7 days while it stays the same; one "all clear" when it empties.
 *
 * The state file is COMMITTED to a public repo, so it holds only a sha256 of
 * the sorted lines - never the lines. The lines themselves never quote a
 * client name (normalize.ts reports rows and columns, not cell text).
 *
 * Nothing here runs without a sender AND recipients: absent secrets mean one
 * log line and no change, which is how the pipeline behaved before task 10.
 */

export const STATE_FILE = 'feed/alert-state.json'
/** Written by a failed sync (gitignored .cache/) for alert-failure.ts to send. */
export const ERROR_FILE = '.cache/sync-error.txt'
export const REMIND_EVERY_MS = 7 * 24 * 60 * 60 * 1000

export type Audience = 'recruiters' | 'team' | 'failure'

export interface Track {
  /** sha256 of the sorted lines last emailed. */
  fingerprint: string
  /** When this exact list was first emailed. */
  since: string
  lastSent: string
}

export interface AlertState {
  version: 1
  audiences: Partial<Record<Audience, Track>>
}

export const emptyState = (): AlertState => ({ version: 1, audiences: {} })

/** '' for no lines, else sha256 of the sorted lines. Order-independent on purpose. */
export function fingerprint(lines: string[]): string {
  if (!lines.length) return ''
  return createHash('sha256').update([...lines].sort().join('\n')).digest('hex')
}

export type Kind = 'new' | 'reminder' | 'clear' | 'none'

/** What to send for one audience, and the track to keep if it is sent. */
export function decide(track: Track | undefined, lines: string[], now: Date): { kind: Kind; next: Track | undefined } {
  const fp = fingerprint(lines)
  const at = now.toISOString()
  const prev = track?.fingerprint ?? ''
  if (fp && fp !== prev) return { kind: 'new', next: { fingerprint: fp, since: at, lastSent: at } }
  if (fp && track && now.getTime() - Date.parse(track.lastSent) >= REMIND_EVERY_MS) return { kind: 'reminder', next: { ...track, lastSent: at } }
  if (!fp && prev) return { kind: 'clear', next: undefined }
  return { kind: 'none', next: track }
}

// ---------------------------------------------------------------- sending

export interface Mail {
  to: string[]
  subject: string
  text: string
}

export interface Mailer {
  name: string
  send(mail: Mail): Promise<void>
}

export type Env = Record<string, string | undefined>

/**
 * Gmail (SMTP_USER + SMTP_PASS, an app password) when set - it can mail anyone.
 * Otherwise Resend (RESEND_API_KEY + ALERT_FROM), which without a verified
 * domain can only mail the Resend account's own address. null = no sender.
 */
export function mailerFromEnv(env: Env, fetchImpl: typeof fetch = fetch): Mailer | null {
  if (env.SMTP_USER && env.SMTP_PASS) {
    const user = env.SMTP_USER
    const pass = env.SMTP_PASS
    return {
      name: 'Gmail',
      async send(m) {
        const { createTransport } = await import('nodemailer')
        const t = createTransport({ service: 'gmail', auth: { user, pass } })
        await t.sendMail({ from: `HPG job board <${user}>`, to: m.to.join(', '), subject: m.subject, text: m.text })
      },
    }
  }
  if (env.RESEND_API_KEY && env.ALERT_FROM) {
    const key = env.RESEND_API_KEY
    const from = env.ALERT_FROM
    return {
      name: 'Resend',
      async send(m) {
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from, to: m.to, subject: m.subject, text: m.text }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { name?: string }
          throw new Error(`Resend refused the email (HTTP ${res.status}${body.name ? `, ${body.name}` : ''})`)
        }
      },
    }
  }
  return null
}

/** Comma-separated addresses -> a de-duplicated list. */
export function addresses(s: string | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const a of (s ?? '').split(',').map((x) => x.trim()).filter((x) => x.includes('@'))) {
    if (seen.has(a.toLowerCase())) continue
    seen.add(a.toLowerCase())
    out.push(a)
  }
  return out
}

/**
 * The team email is a superset of the recruiters' one and fires whenever it
 * does, so anyone on BOTH lists gets only the team copy - one email, not two.
 */
export function recipients(env: Env): Record<'recruiters' | 'team', string[]> {
  const team = addresses(env.ALERT_TO_TEAM)
  const onTeam = new Set(team.map((a) => a.toLowerCase()))
  return { team, recruiters: addresses(env.ALERT_TO).filter((a) => !onTeam.has(a.toLowerCase())) }
}

// ---------------------------------------------------------------- the words

export interface Findings {
  problems: Problem[]
  needsCopy: Array<{ brand: Brand; title: string }>
  /** Link to the Actions run, for the team email. */
  runUrl?: string
}

const lines = (f: Findings, audience: 'recruiters' | 'team') => [
  ...f.problems.filter((p) => p.level !== 'fixed').map((p) => p.message),
  ...(audience === 'team' ? f.needsCopy.map((n) => `No written job post: ${TAB[n.brand]} - ${n.title}`) : []),
]

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Manila' })
const things = (n: number) => (n === 1 ? '1 thing' : `${n} things`)
const list = (head: string, items: string[]) => (items.length ? ['', head, ...items.map((i) => `- ${i}`)] : [])

const FOOT = ['', 'You do not need to reply. If something here is unclear, ask Jasmin.', '', '- The HPG job board (automatic message)']

export function syncEmail(audience: 'recruiters' | 'team', kind: Exclude<Kind, 'none'>, f: Findings, track: Track | undefined): Omit<Mail, 'to'> {
  const tag = audience === 'team' ? '[hpg-jobs] ' : ''
  const held = f.problems.filter((p) => p.level === 'held').map((p) => p.message)
  const skipped = f.problems.filter((p) => p.level === 'skipped').map((p) => p.message)
  const n = held.length + skipped.length
  const out = ['Hello,', '', 'This is the automatic check of the MR sheet (the manpower request Google Sheet) that fills the Careers pages on the HPG websites. It runs about every 30 minutes.', '']

  if (kind === 'clear') {
    out.push('Good news: everything flagged in earlier emails is now fixed. Every ACTIVE role in the sheet is showing on the websites again.')
    return { subject: `${tag}MR sheet: all clear`, text: [...out, ...FOOT, ...(audience === 'team' && f.runUrl ? ['', `Run: ${f.runUrl}`] : [])].join('\n') }
  }

  if (kind === 'reminder') out.push(`A reminder: the items below were first reported on ${day(track!.since)} and are still waiting. You get this reminder once a week while nothing changes.`)
  else if (n) out.push(`It found ${things(n)} in the sheet that keep roles off the websites. Each line says which tab and row to look at and what to change. Once fixed, the websites update by themselves at the next check, and you will get one more email saying all is clear.`)
  else out.push('Nothing in the sheet needs fixing. This email is for the developer only.')

  out.push(...list('HELD BACK - the website keeps showing the previous list for this company until this is sorted. If a drop in roles is real (they really closed), tell Jasmin and she will release it:', held))
  out.push(...list('NOT SHOWN ON THE WEBSITE - please fix these in the sheet:', skipped))
  if (audience === 'team') {
    out.push(...list('NO WRITTEN JOB POST YET - showing the sheet\'s own duties; add them to copy/roles.json:', f.needsCopy.map((x) => `${TAB[x.brand]}: ${x.title}`)))
    out.push(...list('Fixed automatically (for information only):', f.problems.filter((p) => p.level === 'fixed').map((p) => p.message)))
  }
  out.push(...FOOT)
  if (audience === 'team' && f.runUrl) out.push('', `Run: ${f.runUrl}`)

  const subject = n
    ? kind === 'reminder' ? `${tag}Reminder: the MR sheet still has ${things(n)} to fix` : `${tag}MR sheet: ${things(n)} to fix`
    : `${tag}MR sheet: ${f.needsCopy.length} role(s) need a written job post`
  return { subject, text: out.join('\n') }
}

export function failureEmail(kind: Exclude<Kind, 'none'>, error: string, track: Track | undefined, runUrl?: string): Omit<Mail, 'to'> {
  if (kind === 'clear') {
    return { subject: '[hpg-jobs] The sync is working again', text: ['The MR sheet sync ran successfully again. The job list on the sites is current.', ...(runUrl ? ['', `Run: ${runUrl}`] : [])].join('\n') }
  }
  const text = [
    kind === 'reminder' ? `Reminder: the MR sheet sync has been failing since ${day(track!.since)}, with the same error.` : 'The MR sheet sync could not run.',
    '',
    `Error: ${error}`,
    '',
    'The websites are not affected beyond going stale: they keep showing the last good job list until a sync succeeds.',
    'Usual causes: the sheet was unshared or its sharing changed (Google then answers with a sign-in page), the robot account lost access, or a secret is wrong.',
    ...(runUrl ? ['', `Run: ${runUrl}`] : []),
  ]
  return { subject: kind === 'reminder' ? '[hpg-jobs] Reminder: the sync is still failing' : '[hpg-jobs] The sync could not run', text: text.join('\n') }
}

// ---------------------------------------------------------------- delivery

export interface DeliverResult {
  state: AlertState
  changed: boolean
  sent: string[]
}

interface Job {
  audience: Audience
  to: string[]
  lines: string[]
  mail: (kind: Exclude<Kind, 'none'>, track: Track | undefined) => Omit<Mail, 'to'>
}

async function deliver(jobs: Job[], state: AlertState, mailer: Mailer | null, now: Date, log: (s: string) => void): Promise<DeliverResult> {
  const unchanged = { state, changed: false, sent: [] }
  if (!mailer) {
    log('Alert emails are off: no sender set (SMTP_USER + SMTP_PASS, or RESEND_API_KEY + ALERT_FROM).')
    return unchanged
  }
  const live = jobs.filter((j) => j.to.length)
  if (!live.length) {
    log('Alert emails are off: no recipients set (ALERT_TO, ALERT_TO_TEAM).')
    return unchanged
  }
  const next: AlertState = { version: 1, audiences: { ...state.audiences } }
  const sent: string[] = []
  for (const j of live) {
    const track = state.audiences[j.audience]
    const d = decide(track, j.lines, now)
    if (d.kind === 'none') continue
    const mail = { to: j.to, ...j.mail(d.kind, track) }
    try {
      await mailer.send(mail)
    } catch (e) {
      // keep the old track: the next run tries again
      log(`Could not send the ${j.audience} alert through ${mailer.name}: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    if (d.next) next.audiences[j.audience] = d.next
    else delete next.audiences[j.audience]
    sent.push(`${j.audience}:${d.kind}`)
    log(`Sent the ${j.audience} alert (${d.kind}) through ${mailer.name} to ${j.to.length} address(es).`)
  }
  return { state: next, changed: sent.length > 0, sent }
}

/** After a successful sync: the recruiters' and team reports, plus "working again" if the last run failed. */
export function deliverSyncAlerts(o: { env: Env; state: AlertState; findings: Findings; mailer: Mailer | null; now: Date; log?: (s: string) => void }): Promise<DeliverResult> {
  const to = recipients(o.env)
  const f = o.findings
  return deliver(
    [
      { audience: 'recruiters', to: to.recruiters, lines: lines(f, 'recruiters'), mail: (k, t) => syncEmail('recruiters', k, f, t) },
      { audience: 'team', to: to.team, lines: lines(f, 'team'), mail: (k, t) => syncEmail('team', k, f, t) },
      { audience: 'failure', to: to.team, lines: [], mail: (k, t) => failureEmail(k, '', t, f.runUrl) },
    ],
    o.state, o.mailer, o.now, o.log ?? console.log,
  )
}

/** After a failed run: tell the team, once per distinct error (+ weekly reminder). */
export function deliverFailureAlert(o: { env: Env; state: AlertState; error: string; mailer: Mailer | null; now: Date; runUrl?: string; log?: (s: string) => void }): Promise<DeliverResult> {
  return deliver([{ audience: 'failure', to: recipients(o.env).team, lines: [o.error], mail: (k, t) => failureEmail(k, o.error, t, o.runUrl) }], o.state, o.mailer, o.now, o.log ?? console.log)
}

export function runUrl(env: Env): string | undefined {
  return env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined
}

export function loadState(path = STATE_FILE): AlertState {
  if (!existsSync(path)) return emptyState()
  const s = JSON.parse(readFileSync(path, 'utf8')) as Partial<AlertState>
  return s.version === 1 && s.audiences ? (s as AlertState) : emptyState()
}

export function saveState(s: AlertState, path = STATE_FILE): void {
  writeFileSync(path, JSON.stringify(s, null, 2) + '\n')
}
