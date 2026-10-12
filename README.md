# hpg-jobs

Turns the client's MR (manpower request) Google Sheet into **`feed/jobs.json`**, the open-roles
list every HPG site's Careers page reads. The recruiters keep editing the sheet as they always
have; this repo checks what they typed, adds our written job posts, and publishes only what is
safe to show. The plan, decisions and remaining work are in [PLAN.md](PLAN.md).

## What is published, and what never is

| From the sheet, live | Written by us, once per role (`copy/roles.json`) | Never read past the reader |
|---|---|---|
| open or not (MR STATUS), openings left, city/province, job type, request date | title, category, summary, responsibilities, what we look for | client and store names, recruiters, rates, urgency, notes, the QUALIFICATIONS column |

The CLIENTS column is read for one reason only: any public text containing a client's name is
skipped and reported (the report names the row, never the client).

## Run it

```
npm install
MR_XLSX=path/to/export.xlsx npm run sync     # a local export
MR_SHEET_ID=<id> npm run sync                # the live sheet (an Actions secret - never commit it)
ACCEPT_DROP=dssi npm run sync                # confirm a big drop the guard held back
npm test                                     # fixture sheets: merges, bad numbers, renamed columns, leaks, drops
npm run typecheck
```

`sync` writes `feed/jobs.json` only when the jobs changed, and always writes `report.md`
(gitignored): what was fixed, skipped or held, in words a recruiter can act on.

## The rules, in short

- **Fixed silently:** spacing, ALL CAPS, `56.0`, known typos, the sheet's broken `ñ`.
- **Skipped and reported:** openings that aren't a number or are absurd (>2000), an MR STATUS the
  site doesn't know, a client name in public text.
- **Held (last good list kept):** a tab that is missing or lost a required column; a brand whose
  open roles fell by more than half in one sync (`ACCEPT_DROP` releases it).
- **No written post yet:** the role still publishes with the sheet's duties under "Other", and
  the report lists it. Add it to `copy/roles.json`. A post that mentions age, sex, height, looks
  or civil status fails the run (RA 10911).

## Layout

```
src/read.ts       xlsx -> raw lines (merged cells, columns found by header name)
src/normalize.ts  validate + clean -> jobs, plus the problem list
src/copy.ts       loads + checks copy/roles.json
src/feed.ts       jobs + copy -> feed, the hold and big-drop guards
src/sync.ts       the command: download, run, write feed + report
copy/roles.json   the written job posts
feed/jobs.json    THE OUTPUT - public, read by the sites
test/             fixture workbooks built in code
```
