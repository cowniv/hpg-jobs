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
MR_SHEET_ID=<id> GOOGLE_SA_KEY="$(cat key.json)" npm run sync   # as the robot account (task 9)
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
src/source.ts     where the xlsx comes from: local file, robot account, or public link
src/google.ts     service-account sign-in (a signed JWT, node:crypto only)
src/alert.ts      the alert emails: who gets what, when, and the words
src/alert-failure.ts  npm run alert:failure - the workflow's "sync failed" email
src/sync.ts       the command: download, run, write feed + report, send alerts
copy/roles.json   the written job posts
feed/jobs.json    THE OUTPUT - public, read by the sites
feed/alert-state.json  which problem lists were already emailed (sha256 hashes only)
test/             fixture workbooks built in code
```

## Reading the sheet as a robot (task 9)

With the secret `GOOGLE_SA_KEY` set, the sync signs in as a read-only Google service account and
downloads the sheet through the **Drive API export** - the same xlsx file the public link gives,
so nothing about how the sheet is read changes. Without the key it uses the public link, as
before. Once the robot works, the client can set the sheet to **Restricted** (only people and
the robot it is shared with). The key and the sign-in token are never written to the log.

## Alert emails (task 10)

After every sync, if something keeps roles off the sites - a tab held back, a row skipped - an
email says which tab, which row and what to change. Nobody is emailed every 30 minutes about the
same thing:

- an email goes out when the list of problems **changes**;
- while it stays the same, a **reminder** at most once every 7 days;
- when it goes from some problems to none, one **"all clear"**.

`feed/alert-state.json` remembers what was sent, as a sha256 of the problem lines (no text - this
repo is public). Automatic fixes never trigger an email on their own.

| Secret | Gets |
|---|---|
| `ALERT_TO` | the problems, in recruiter language (Jasmin + the client's recruitment lead) |
| `ALERT_TO_TEAM` | the same, plus roles with no written post, the automatic fixes, a link to the run, and an email when the sync itself fails (Jasmin) |

Anyone on both lists gets the team email only, once. Problem lines never contain a client name.

**Sender**: Gmail (`SMTP_USER` + `SMTP_PASS`) or Resend (`RESEND_API_KEY` + `ALERT_FROM`); Gmail
wins if both are set. **Use Gmail to reach the client**: Resend's free tier, without a domain
verified with them, only delivers to the Resend account's own email address, so the recruitment
lead would never get anything. With no sender or no recipients the sync logs one line ("Alert
emails are off") and behaves exactly as it did before.

If the sync itself fails (sheet unshared, a sign-in page instead of the file, a bad secret), the
workflow's failure step runs `npm run alert:failure`: `ALERT_TO_TEAM` hears once per distinct
error (then weekly), and gets "working again" after the next good run.

## A reliable timer (task 6b)

GitHub runs a free repo's schedule when it gets round to it - twice in 23 hours, once. So an
outside timer starts the workflow every 30 minutes, and the GitHub schedule stays as a backup. The
workflow's `concurrency` group means the two can never run at the same time: a run that arrives
while one is going waits, and GitHub keeps at most one waiting (a newer arrival replaces it, which
shows as a cancelled run - harmless). The outside timer fires at :00/:30 and the backup at :07/:37,
so they do not collide. Once the outside timer has run reliably for a week or two, the backup can
be slowed to `'7 */2 * * *'` in `.github/workflows/sync.yml`; it is not needed every 30 minutes.

1. **Make a token.** GitHub > Settings > Developer settings > Personal access tokens >
   **Fine-grained tokens** > Generate new token. Name `cron-job.org hpg-jobs`; expiration: the
   longest offered (put its renewal in your calendar); Repository access: **Only select
   repositories** > `cowniv/hpg-jobs`; Permissions > Repository permissions > **Actions: Read and
   write**, nothing else. Generate and copy the token.
2. **Make the job.** Sign up free at <https://cron-job.org> > Create cronjob:
   - Title: `hpg-jobs sync`
   - URL: `https://api.github.com/repos/cowniv/hpg-jobs/actions/workflows/sync.yml/dispatches`
   - Schedule: every 30 minutes (custom: minutes `0,30` of every hour). Not `7,37`: that is the
     backup's slot, and the two would land together and run back to back for nothing.
   - Advanced > Request method: **POST**
   - Headers:
     - `Accept: application/vnd.github+json`
     - `Authorization: Bearer <the token>`
     - `X-GitHub-Api-Version: 2022-11-28`
     - `Content-Type: application/json`
   - Request body: `{"ref":"main"}`
3. **Test it** with cron-job.org's "Test run": expect **HTTP 204** (no content), and a new "sync"
   run in this repo's Actions tab marked `workflow_dispatch`. 401/403 = the token is wrong or lacks
   Actions write; 404 = the URL or the token's repository access; 422 = the body.
4. Turn on cron-job.org's "notify me on failure" for the job.

## What Jasmin needs to set up

All of this is already coded; each piece switches on the moment its secrets exist. Secrets go in
GitHub: this repo > Settings > Secrets and variables > Actions > **New repository secret**. After
adding them, run the workflow by hand (Actions > sync > Run workflow) and read its log.

**Task 9 - robot access.** Secret: `GOOGLE_SA_KEY`.

1. <https://console.cloud.google.com> > project picker > **New project** (`hpg-jobs`; no billing).
2. APIs & Services > Library > **Google Drive API** > Enable.
3. IAM & Admin > Service accounts > **Create service account** (`hpg-jobs-reader`). Skip the
   optional role and user-access steps - it needs no project role.
4. Open it > Keys > Add key > Create new key > **JSON**. A `.json` file downloads. Keep it out of
   every repo, and delete the local copy once it is pasted.
5. Copy the service account's email (`hpg-jobs-reader@<project>.iam.gserviceaccount.com`). In the
   MR sheet: Share > paste that email > **Viewer** > untick "Notify people" > Share. (If the
   client owns the sheet, they do this step.)
6. Add the secret `GOOGLE_SA_KEY` = the whole contents of the JSON file, `{` to `}`.
7. Run the workflow; the log should say "Reading the sheet as the robot account". Then ask the
   client to set the sheet's General access to **Restricted**, and run it once more.

**Task 10 - alert emails.** Secrets: `ALERT_TO`, `ALERT_TO_TEAM`, `SMTP_USER`, `SMTP_PASS`.

1. Pick the Gmail account that sends (a dedicated one, such as a new job-board Gmail, is tidier
   than a personal one).
2. Turn on **2-Step Verification** for it: <https://myaccount.google.com/security>.
3. Create an **app password**: <https://myaccount.google.com/apppasswords>, name `hpg-jobs`. Copy
   the 16 characters.
4. Secrets: `SMTP_USER` = that Gmail address; `SMTP_PASS` = the app password; `ALERT_TO` = your
   address and the recruitment lead's, comma-separated; `ALERT_TO_TEAM` = your address.
5. (Instead of Gmail: `RESEND_API_KEY` + `ALERT_FROM`, e.g. `HPG job board <onboarding@resend.dev>`
   - but see "Sender" above: without a verified domain it can only reach you.)

**Task 6b - reliable timer.** No repo secrets: the token lives in cron-job.org. Follow "A reliable
timer" above - a fine-grained token (this repo only, Actions read & write) and a cron-job.org job.
