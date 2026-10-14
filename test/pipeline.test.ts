import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { loadCopy, type CopyFile } from '../src/copy.ts'
import { buildFeed, feedProblem, sameContent, type Feed } from '../src/feed.ts'
import { normalize } from '../src/normalize.ts'
import { readWorkbook } from '../src/read.ts'
import { HEADER, workbook, type Block } from './fixture.ts'

const COPY = loadCopy(JSON.parse(readFileSync('copy/roles.json', 'utf8')) as CopyFile)
const NOW = '2026-10-12T00:00:00.000Z'

async function run(tabs: Parameters<typeof workbook>[0], previous: Feed | null = null, acceptDrop?: Feed['jobs'][number]['brand'][]) {
  const read = await readWorkbook(await workbook(tabs))
  const norm = normalize(read.lines, read.clientNames)
  const built = buildFeed({ jobs: norm.jobs, held: read.held, copy: COPY, previous, now: NOW, acceptDrop })
  return { ...built, problems: [...read.problems, ...norm.problems, ...built.problems] }
}

const ok = (blocks: Block[]) => ({ HELPRO: { blocks: [] }, DSSI: { blocks }, DSIC: { blocks: [] }, GR8STAFF: { blocks: [] } })
const many = (n: number): Block[] => Array.from({ length: n }, (_, i) => ({ status: 'ACTIVE', remaining: 2, lines: [[['Carpenter', 'Mason', 'Steelman', 'Plumber', 'Driver', 'Utility'][i % 6]!, 2, 'Pasig']] }))

describe('reading the sheet', () => {
  it('counts a merged count once, not once per row', async () => {
    const { feed } = await run(ok([{ status: 'ACTIVE', remaining: 70, lines: [['DRIVER', 30, 'LAGUNA'], ['', 40, 'PASIG'], ['', '', '']] }]))
    assert.equal(feed.jobs.length, 1)
    assert.equal(feed.jobs[0]!.openings, 70)
    assert.deepEqual(feed.jobs[0]!.areas, ['Laguna', 'Pasig'])
  })

  it('uses each line\'s breakdown when a block has several titles', async () => {
    const { feed } = await run(ok([{ status: 'ACTIVE', remaining: 9, lines: [['Carpenter', 4, 'Pampanga'], ['Mason', 5, '']] }]))
    const by = Object.fromEntries(feed.jobs.map((j) => [j.title, j]))
    assert.equal(by['Carpenter']!.openings, 4)
    assert.equal(by['Mason']!.openings, 5)
    assert.deepEqual(by['Mason']!.areas, ['Pampanga'], 'blank area means same as above')
  })

  it('accepts " 56 ", "56.0" and "1,080" as numbers', async () => {
    for (const [v, want] of [[' 56 ', 56], ['56.0', 56], ['1,080', 1080]] as const) {
      const { feed } = await run(ok([{ status: 'ACTIVE', remaining: v, lines: [['Driver', '', 'Pasig']] }]))
      assert.equal(feed.jobs[0]?.openings, want, `remaining ${JSON.stringify(v)}`)
    }
  })

  it('shows only ACTIVE requests, and reports a status it does not know', async () => {
    const { feed, problems } = await run(ok([
      { status: 'ACTIVE', remaining: 2, lines: [['Driver', '', 'Pasig']] },
      { status: 'ON HOLD', remaining: 2, lines: [['Mason', '', 'Pasig']] },
      { status: 'INACTIVE', remaining: 2, lines: [['Carpenter', '', 'Pasig']] },
      { status: 'ACTVE', remaining: 2, lines: [['Plumber', '', 'Pasig']] },
    ]))
    assert.deepEqual(feed.jobs.map((j) => j.title), ['Delivery Driver'])
    assert.ok(problems.some((p) => p.level === 'skipped' && p.message.includes('"ACTVE"')))
  })

  it('treats 0 openings left as filled, silently', async () => {
    const { feed, problems } = await run(ok([{ status: 'ACTIVE', remaining: 0, lines: [['Driver', '', 'Pasig']] }]))
    assert.equal(feed.jobs.length, 0)
    assert.equal(problems.length, 0)
  })
})

describe('bad input never reaches the site', () => {
  it('skips a request whose openings is not a number, and says where', async () => {
    const { feed, problems } = await run(ok([{ status: 'ACTIVE', remaining: 'Juan', lines: [['Driver', '', 'Pasig']] }]))
    assert.equal(feed.jobs.length, 0)
    const p = problems.find((x) => x.level === 'skipped')!
    assert.match(p.message, /DSSI tab, row 2/)
    assert.match(p.message, /isn't a number/)
  })

  it('skips an absurd count as a typo', async () => {
    const { feed, problems } = await run(ok([{ status: 'ACTIVE', remaining: 50000, lines: [['Driver', '', 'Pasig']] }]))
    assert.equal(feed.jobs.length, 0)
    assert.ok(problems.some((p) => /typo/.test(p.message)))
  })

  it('never publishes a client name - and never repeats it in a report', async () => {
    const { feed, problems } = await run(ok([{ client: 'Acme Retail Corp', status: 'ACTIVE', remaining: 3, lines: [['Driver', '', 'Acme Retail Corp Pasig']] }]))
    const all = JSON.stringify(feed) + JSON.stringify(problems)
    assert.ok(!/acme/i.test(all), all)
    assert.ok(problems.some((p) => /client's name/.test(p.message)))
  })

  it('never publishes the sheet\'s qualifications (age, sex, height)', async () => {
    const { feed } = await run(ok([{ status: 'ACTIVE', remaining: 3, lines: [['Driver', '', 'Pasig']] }]))
    assert.ok(!/male|years old|5'5/i.test(JSON.stringify(feed)))
  })

  it('fixes known typos and the broken ñ, and reports it as fixed', async () => {
    const { feed, problems } = await run(ok([{ status: 'ACTIVE', remaining: 3, lines: [['Driver', '', 'PARA�AQUE / MEYACUAYAN']] }]))
    assert.deepEqual(feed.jobs[0]!.areas, ['Parañaque / Meycauayan'])
    assert.ok(problems.every((p) => p.level === 'fixed'))
  })
})

describe('holding back the last good list', () => {
  it('holds a tab whose required column was renamed, keeping its last good jobs', async () => {
    const good = await run(ok(many(3)))
    const renamed = HEADER.map((h) => (h === 'MR STATUS' ? 'STATUS' : h))
    const { feed, problems } = await run({ ...ok([]), DSSI: { header: renamed, blocks: many(1) } }, good.feed)
    assert.equal(feed.brands.dssi.state, 'held')
    assert.deepEqual(feed.jobs, good.feed.jobs)
    assert.ok(problems.some((p) => p.level === 'held' && /MR STATUS/.test(p.message)))
  })

  it('holds a tab that was deleted', async () => {
    const good = await run(ok(many(3)))
    const { HELPRO, DSIC, GR8STAFF } = ok([])
    const { feed } = await run({ HELPRO, DSIC, GR8STAFF }, good.feed)
    assert.equal(feed.brands.dssi.state, 'held')
    assert.equal(feed.jobs.length, good.feed.jobs.length)
  })

  it('gives each problem a key with no row number or live count, so the alert fingerprint survives row edits', async () => {
    const bad: Block = { status: 'ACTIVE', remaining: 'Juan', lines: [['Driver', '', 'Pasig']] }
    const filler: Block = { status: 'ACTIVE', remaining: 1, lines: [['Mason', 1, 'Pasig']] }
    const a = (await run(ok([bad]))).problems.find((x) => x.level === 'skipped')!
    const b = (await run(ok([filler, bad]))).problems.find((x) => x.level === 'skipped')!
    assert.notEqual(a.message, b.message, 'the message still names the row')
    assert.ok(a.key && a.key === b.key)
    const good = await run(ok(many(6)))
    const k = (n: number) => run(ok(many(n)), good.feed).then((r) => r.problems.find((x) => x.level === 'held')!.key)
    assert.equal(await k(2), await k(1), 'a held tab edited further keeps its key')
  })

  it('holds a brand that lost more than half its jobs at once, until a person accepts it', async () => {
    const good = await run(ok(many(6)))
    assert.equal(good.feed.jobs.length, 6)
    const dropped = await run(ok(many(2)), good.feed)
    assert.equal(dropped.feed.brands.dssi.state, 'held')
    assert.equal(dropped.feed.jobs.length, 6)
    assert.ok(dropped.problems.some((p) => p.level === 'held' && /fell from 6 to 2/.test(p.message)))
    const accepted = await run(ok(many(2)), good.feed, ['dssi'])
    assert.equal(accepted.feed.brands.dssi.state, 'live')
    assert.equal(accepted.feed.jobs.length, 2)
  })

  it('lets a small list empty normally (one role filling is not an accident)', async () => {
    const good = await run(ok(many(2)))
    const { feed } = await run(ok([]), good.feed)
    assert.equal(feed.brands.dssi.state, 'live')
    assert.equal(feed.jobs.length, 0)
  })

  it('reports no change when only timestamps differ', async () => {
    const a = await run(ok(many(3)))
    const b = await run(ok(many(3)), a.feed)
    assert.ok(sameContent(a.feed, { ...b.feed, generatedAt: 'later' }))
  })
})

describe('written copy', () => {
  it('replaces the sheet\'s wording and merges titles that share a post', async () => {
    const { feed, needsCopy } = await run(ok([
      { status: 'ACTIVE', remaining: 4, lines: [['REPACKER', '', 'Laguna']] },
      { status: 'ACTIVE', remaining: 6, lines: [['WAREHOUSEMAN', '', 'Pasig']] },
    ]))
    assert.equal(feed.jobs.length, 1)
    assert.equal(feed.jobs[0]!.title, 'Warehouse Staff')
    assert.equal(feed.jobs[0]!.openings, 10)
    assert.equal(needsCopy.length, 0)
  })

  it('publishes an unknown title with the sheet\'s duties and lists it as needing copy', async () => {
    const { feed, needsCopy } = await run(ok([{ status: 'ACTIVE', remaining: 1, duties: 'Fly the drone. Log flights.', lines: [['Drone Pilot', '', 'Cebu']] }]))
    assert.equal(feed.jobs[0]!.category, 'Other')
    assert.ok(feed.jobs[0]!.responsibilities.length > 0)
    assert.deepEqual(needsCopy, [{ brand: 'dssi', title: 'Drone Pilot' }])
  })

  it('refuses a written post that mentions age, sex or height', () => {
    const bad: CopyFile = { categories: ['X'], roles: [{ match: [], title: 'T', category: 'X', summary: 's', responsibilities: ['r'], lookingFor: ['Male, 18 to 30 years old'] }] }
    assert.throws(() => loadCopy(bad), /age, sex, height/)
  })

  it('refuses one title matched by two posts', () => {
    const r = { category: 'X', summary: 's', responsibilities: ['r'], lookingFor: ['l'] }
    assert.throws(() => loadCopy({ categories: ['X'], roles: [{ ...r, title: 'A', match: ['driver'] }, { ...r, title: 'B', match: ['driver'] }] }), /both/)
  })
})

describe('the feed shape', () => {
  it('passes its own check, and a damaged one does not', async () => {
    const { feed } = await run(ok(many(2)))
    assert.equal(feedProblem(feed), null)
    assert.notEqual(feedProblem({ ...feed, schema: 2 }), null)
    assert.notEqual(feedProblem({ jobs: 'x' }), null)
  })
})
