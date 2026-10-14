import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { decide, deliverFailureAlert, deliverSyncAlerts, emptyState, fingerprint, loadState, mailerFromEnv, recipients, REMIND_EVERY_MS, type AlertState, type Findings, type Mail, type Mailer } from '../src/alert.ts'
import type { Problem } from '../src/types.ts'

const T0 = new Date('2026-10-14T00:00:00.000Z')
const later = (ms: number) => new Date(T0.getTime() + ms)
const HOUR = 3600_000

const skipped: Problem = { level: 'skipped', brand: 'dssi', row: 14, message: 'DSSI tab, row 14 (Driver): openings left is "Juan", which isn\'t a number. Not shown on the site until it is.' }
const held: Problem = { level: 'held', brand: 'dsic', message: 'The DSIC tab is missing column(s) the site needs: MR STATUS.' }
const fixed: Problem = { level: 'fixed', brand: 'helpro', row: 3, message: 'HELPRO tab, row 3: "Mantenance" corrected to "Maintenance".' }

const ENV = { ALERT_TO: 'lead@client.example, jasmin@example.com', ALERT_TO_TEAM: 'jasmin@example.com' }

/** A transport that records instead of sending. No network in tests. */
function fakeMailer(fail = false): Mailer & { sent: Mail[] } {
  const sent: Mail[] = []
  return { name: 'fake', sent, async send(m) { if (fail) throw new Error('smtp down'); sent.push(m) } }
}

async function sync(state: AlertState, findings: Findings, now: Date, mailer: Mailer | null = fakeMailer(), env: Record<string, string> = ENV) {
  const logs: string[] = []
  const res = await deliverSyncAlerts({ env, state, findings, mailer, now, log: (s) => logs.push(s) })
  return { ...res, logs }
}

describe('alert fingerprints', () => {
  it('ignores order, and is empty for no problems', () => {
    assert.equal(fingerprint([]), '')
    assert.equal(fingerprint(['a', 'b']), fingerprint(['b', 'a']))
    assert.notEqual(fingerprint(['a']), fingerprint(['a', 'b']))
    assert.match(fingerprint(['a']), /^[0-9a-f]{64}$/, 'a hash only - no text in the committed state')
  })

  it('emails on a change, stays quiet while unchanged, reminds after 7 days, clears once', () => {
    const first = decide(undefined, ['x'], T0)
    assert.equal(first.kind, 'new')
    assert.equal(decide(first.next, ['x'], later(HOUR)).kind, 'none')
    assert.equal(decide(first.next, ['x'], later(REMIND_EVERY_MS - HOUR)).kind, 'none')
    const remind = decide(first.next, ['x'], later(REMIND_EVERY_MS))
    assert.equal(remind.kind, 'reminder')
    assert.equal(remind.next!.since, first.next!.since, 'a reminder keeps the first-reported date')
    assert.equal(decide(remind.next, ['x'], later(REMIND_EVERY_MS + HOUR)).kind, 'none', 'next reminder is 7 days after the LAST email')
    assert.equal(decide(first.next, ['x', 'y'], later(HOUR)).kind, 'new')
    const clear = decide(first.next, [], later(HOUR))
    assert.equal(clear.kind, 'clear')
    assert.equal(decide(clear.next, [], later(2 * HOUR)).kind, 'none', 'all clear is sent once')
    assert.equal(decide(undefined, [], T0).kind, 'none', 'nothing wrong, nothing ever flagged: no email')
  })
})

describe('alert emails (task 10)', () => {
  it('do nothing - one log line, state unchanged - when no sender is set', async () => {
    const state = emptyState()
    const r = await sync(state, { problems: [skipped], needsCopy: [] }, T0, mailerFromEnv(ENV))
    assert.equal(r.changed, false)
    assert.equal(r.state, state)
    assert.equal(r.logs.length, 1)
    assert.match(r.logs[0]!, /Alert emails are off: no sender/)
  })

  it('do nothing when there are no recipients', async () => {
    const m = fakeMailer()
    const r = await sync(emptyState(), { problems: [skipped], needsCopy: [] }, T0, m, {})
    assert.equal(r.changed, false)
    assert.equal(m.sent.length, 0)
    assert.match(r.logs.join(), /no recipients/)
  })

  it('send the recruiters the problems, and the team the problems plus the developer list - one copy each', async () => {
    const m = fakeMailer()
    const r = await sync(emptyState(), { problems: [skipped, held, fixed], needsCopy: [{ brand: 'dsic', title: 'Forklift Operator' }] }, T0, m)
    assert.deepEqual(r.sent, ['recruiters:new', 'team:new'])
    const [rec, team] = m.sent
    assert.deepEqual(rec!.to, ['lead@client.example'], 'Jasmin is on both lists and gets only the team copy')
    assert.deepEqual(team!.to, ['jasmin@example.com'])
    assert.match(rec!.subject, /2 things to fix/)
    assert.match(rec!.text, /DSSI tab, row 14/)
    assert.match(rec!.text, /HELD BACK/)
    assert.doesNotMatch(rec!.text, /Forklift|Mantenance|copy\/roles\.json/, 'no developer detail for the recruiter')
    assert.match(team!.text, /DSIC: Forklift Operator/)
    assert.match(team!.text, /Mantenance/)
  })

  it('do not repeat an unchanged problem every run, and send all clear when it is fixed', async () => {
    const m = fakeMailer()
    const f = { problems: [skipped], needsCopy: [] }
    const a = await sync(emptyState(), f, T0, m)
    const b = await sync(a.state, f, later(HOUR / 2), m)
    assert.equal(b.changed, false)
    assert.equal(m.sent.length, 2)
    const c = await sync(b.state, f, later(REMIND_EVERY_MS), m)
    assert.deepEqual(c.sent, ['recruiters:reminder', 'team:reminder'])
    assert.match(m.sent[2]!.subject, /^Reminder/)
    const d = await sync(c.state, { problems: [fixed], needsCopy: [] }, later(REMIND_EVERY_MS + HOUR), m)
    assert.deepEqual(d.sent, ['recruiters:clear', 'team:clear'])
    assert.match(m.sent[4]!.subject, /all clear/)
    assert.deepEqual(d.state.audiences, {})
    const e = await sync(d.state, { problems: [fixed], needsCopy: [] }, later(REMIND_EVERY_MS + 2 * HOUR), m)
    assert.equal(e.changed, false, 'fixed-only runs never email')
  })

  it('fingerprint the problem key, not the message, so a row moving does not re-send', async () => {
    const m = fakeMailer()
    const at = (row: number): Problem => ({ ...skipped, row, key: 'remaining-nan|dssi|driver|Juan', message: `DSSI tab, row ${row} (Driver): openings left is "Juan".` })
    const a = await sync(emptyState(), { problems: [at(14)], needsCopy: [] }, T0, m)
    const b = await sync(a.state, { problems: [at(15)], needsCopy: [] }, later(HOUR), m)
    assert.equal(b.changed, false)
    assert.equal(m.sent.length, 2)
  })

  it('start from empty when the state file is damaged, rather than stop the sync', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpg-alert-'))
    const logs: string[] = []
    for (const [name, body] of [['conflict.json', '<<<<<<< HEAD\n{}'], ['null.json', 'null'], ['old.json', '{"version":0}']] as const) {
      writeFileSync(join(dir, name), body)
      assert.deepEqual(loadState(join(dir, name), (s) => logs.push(s)), emptyState())
    }
    assert.equal(logs.length, 3)
  })

  it('keep the old state when sending fails, so the next run retries', async () => {
    const r = await sync(emptyState(), { problems: [skipped], needsCopy: [] }, T0, fakeMailer(true))
    assert.equal(r.changed, false)
    assert.deepEqual(r.state.audiences, {})
    assert.match(r.logs.join('\n'), /Could not send the recruiters alert through fake: smtp down/)
  })

  it('tell the team once when the sync fails, and once when it works again', async () => {
    const m = fakeMailer()
    const a = await deliverFailureAlert({ env: ENV, state: emptyState(), error: 'Could not download the MR sheet (HTTP 200, text/html).', mailer: m, now: T0, log: () => {} })
    assert.deepEqual(a.sent, ['failure:new'])
    assert.deepEqual(m.sent[0]!.to, ['jasmin@example.com'], 'failures go to the team only')
    const b = await deliverFailureAlert({ env: ENV, state: a.state, error: 'Could not download the MR sheet (HTTP 200, text/html).', mailer: m, now: later(HOUR), log: () => {} })
    assert.equal(b.changed, false)
    const c = await sync(b.state, { problems: [], needsCopy: [] }, later(2 * HOUR), m)
    assert.deepEqual(c.sent, ['failure:clear'])
    assert.match(m.sent[1]!.subject, /working again/)
  })

  it('pick Gmail over Resend, and Resend only with a sender address', () => {
    assert.equal(mailerFromEnv({ SMTP_USER: 'a@gmail.com', SMTP_PASS: 'p', RESEND_API_KEY: 'k', ALERT_FROM: 'x@y' })!.name, 'Gmail')
    assert.equal(mailerFromEnv({ RESEND_API_KEY: 'k', ALERT_FROM: 'x@y' })!.name, 'Resend')
    assert.equal(mailerFromEnv({ RESEND_API_KEY: 'k' }), null)
    assert.equal(mailerFromEnv({ SMTP_USER: 'a@gmail.com' }), null)
  })

  it('post to Resend with the key as a bearer token', async () => {
    let call: { url: string; init?: RequestInit } | undefined
    const f = (async (u: string | URL, init?: RequestInit) => ((call = { url: String(u), init }), new Response('{}', { status: 200 }))) as typeof fetch
    await mailerFromEnv({ RESEND_API_KEY: 'rk', ALERT_FROM: 'Jobs <onboarding@resend.dev>' }, f)!.send({ to: ['a@b.c'], subject: 's', text: 't' })
    assert.equal(call!.url, 'https://api.resend.com/emails')
    assert.equal((call!.init!.headers as Record<string, string>).authorization, 'Bearer rk')
    assert.deepEqual(JSON.parse(String(call!.init!.body)), { from: 'Jobs <onboarding@resend.dev>', to: ['a@b.c'], subject: 's', text: 't' })
  })

  it('de-duplicate and tidy recipient lists', () => {
    assert.deepEqual(recipients({ ALERT_TO: ' A@x.com,a@x.com, ,b@y.com', ALERT_TO_TEAM: 'b@y.com' }), { team: ['b@y.com'], recruiters: ['A@x.com'] })
  })
})
