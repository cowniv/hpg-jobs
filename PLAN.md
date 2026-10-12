# Careers from the MR sheet — build plan

**Status: in progress.** To resume, tell Claude **"continue execution"**. It finds the first
unticked task below and carries on. Tick a box (`[x]`) when a task is done and verified; add
a one-line note under it if anything was decided along the way.

## The goal

The client's recruiters already keep a Google Sheet of manpower requests ("MR sheet", one tab per
brand: HELPRO, DSSI, DSIC, GR8STAFF). Every brand site's Careers page — and the group page's —
should list the open roles from it automatically, with search and filters, without the client
changing how they work. Budget context: ₱35k/month retainer, so no CMS, no paid services.

## Decisions already made (2026-10-12, with Jasmin)

| | |
|---|---|
| Source | The existing MR sheet. The client keeps editing it as today; no new tabs needed from them. |
| Access | "Anyone with the link" for now, to build and test. Switch to a read-only Google service account later (task 9), then the client sets the sheet to Restricted. |
| What is live vs written | Live from the sheet: open or not (MR STATUS), openings, area (city/province only), job type, posted date. Written by us once per role title: the job post (summary, responsibilities, what we look for, benefits) and its category. |
| Never published | Client names, store names, recruiter names, rates, urgency, internal notes, and the sheet's QUALIFICATIONS text (it carries age / sex / height limits — RA 10911). |
| Apply | Email to the brand's address, role + area + brand in the subject. CVs by email. |
| Validation | Three layers: dropdown/number validation in the sheet (client, optional); fix / skip / hold-back rules in the pipeline; alert emails. |
| Alerts | To Jasmin AND the client's recruitment lead. |
| UI | Search box + filters (Location, Job Type, Category; Company on HPG) + list and detail panel, like the reference screenshot; full-screen detail on phones. |

## Architecture

```
MR Google Sheet ──(every 30 min)──▶ hpg-jobs pipeline (GitHub Action, this repo)
                                     read → fix merged cells → validate → add written copy
                                     → publish feed/jobs.json   → alert on problems
                                                  │
            HPG /careers · HELPRO · DSSI · DSIC · GR8STAFF  ← each Careers page reads jobs.json
```

- **This repo (`cowniv/hpg-jobs`) is PUBLIC** — the free GitHub plan cannot serve a private
  repo's file publicly. It holds code, the written job copy and the cleaned feed only. The sheet
  URL (and later the service-account key) live in **Actions secrets**, never in the repo.
- The sites never touch the sheet. They fetch the feed with a 30-minute revalidate and keep their
  last good copy if it is unreachable.
- Safety: a tab whose columns changed is **held back** (last good version kept); a sudden drop of
  more than half the jobs is treated as a mistake (last good kept + alert).

## Tasks

### Pipeline (this repo)
- [x] **1. Scaffold the repo** — Node + TypeScript, `npm run sync`, `.gitignore`, README.
- [x] **2. Read the sheet** — download the xlsx export once, read all four tabs, forward-fill
      merged cells, map each tab's columns by HEADER NAME (tabs differ: DSIC has AGING/DAYS and no
      TOTAL MR REMAINING).
      *Done: `src/read.ts`. A request = the rows its MR STATUS merge spans; titles/areas fill down
      within a block; counts read from a merge's first row only (else 70 drivers counted 3x).*
- [x] **3. Validate + normalise** — the fix / skip / hold-back rules, area clean-up (title case,
      known typos, broken characters), openings rule per tab, plain-language problem report.
      *Done: `src/normalize.ts`. Live sheet → 50 roles. CLIENTS column read ONLY as a blocklist: a
      client name in any public text skips that line + reports it. Single-title block → openings =
      openings left; multi-title block → each line's MR BREAKDOWN; packed title cell → "multiple".*
- [x] **4. Written job copy** — `copy/roles.json`: one post + category per role title, with
      aliases. Write the ~15 titles active today. Unknown titles still publish (tidied duties)
      and appear in a "needs copy" list.
      *Done: 39 posts in 9 categories cover all 45 live sheet titles (0 need copy). Titles sharing
      a post merge into one listing (Repacker + Warehouseman → Warehouse Staff). DSIC's plain
      "Helper" is an after-sales SERVICE helper, not a delivery helper. `loadCopy` fails the run on
      age/sex/height/looks/civil-status words or one title matched twice.*
- [x] **5. Feed + safety nets** — `feed/jobs.json` (schema-versioned), hold-last-good, the
      big-drop guard, and fixture tests (good sheet, bad numbers, renamed column, empty tab).
      *Done: `src/feed.ts` + `src/sync.ts`, 20 tests on workbooks built in code. Live sheet → 42
      listings. Big drop = a brand with ≥4 roles falling below half; `ACCEPT_DROP=<brand>` releases.
      Problem messages never quote a client name (Action logs on a public repo are public). A
      sign-in page instead of an xlsx (sheet unshared) fails the run and leaves the feed alone.
      Fixed on the way: a restored "ñ" stopped ALL-CAPS areas being title-cased.*
- [x] **6. GitHub Action** — cron every 30 min + manual run; commits the feed only when it
      changed; secret `MR_SHEET_ID`. Push the repo to `cowniv/hpg-jobs` (public).
      *Done: `.github/workflows/sync.yml` (:07 and :37). First manual run green against the live
      sheet. Sites read **`https://raw.githubusercontent.com/cowniv/hpg-jobs/main/feed/jobs.json`**.
      A failed run emails the repo owner (GitHub default) until task 10 adds the report emails.
      Keepalive commit after 45 quiet days, as GitHub stops public schedules at 60.*

### Sites
- [x] **7. HPG `/careers` job board** — search, filters, list + detail, Apply mailto, empty state;
      remove the placeholder vacancies and testimonials (open item 4). Tests on a fixture feed.
      *Done: cowniv/hpg PR #3. `lib/jobs.ts` (fetch + parse, revalidate 1800; build-time failure →
      notice, revalidation failure → keeps last good page), `ui/JobExplorer` (URL is the state via
      useSyncExternalStore - `?q= &company= &location= &type= &category= &job=`), `ui/JobDetail`,
      `ui/JobCard`, `lib/job-format.ts`. Board moved under the hero on a new `bg-jobs-wash`; hero
      counts from the feed. Tests assert invariants of ANY feed (live data), plus parser fixtures.
      **For task 8, copy those five files + the wash token**; pass `companyFilter={false}` and the
      brand to `getJobsFeed([brand])`. With 3 selects the filter grid needs re-balancing.
      TODO(client): all Apply emails go to info@helprofgrp.com until each brand gives a recruitment
      inbox (`JOB_APPLY_EMAIL` in content/careers.ts).*
- [x] **8. Roll out to HELPRO, DSSI, DSIC, GR8STAFF `/careers`** — each shows its own brand.
      *Done: helpro#3, dssi#4, dsic + gr8staff PRs (2026-10-12). The board files are BYTE-IDENTICAL
      in all five repos - `lib/jobs.ts`, `lib/job-format.ts`, `ui/JobExplorer|JobDetail|JobCard`,
      `sections/JobBoard`, `tests/careers-jobs.spec.ts`; change one, copy to all. Per site:
      `content/jobs.ts` (words), `--background-image-jobs-wash` (brand rgb; centre glow capped at
      .07 - DSIC's green eyebrow was 4.30 at .12). Brand hero shows `hiring(n)` + "See Open Roles"
      while the feed has roles, else the old talent-pool line. Grey text is `note`, not `muted`
      (GR8STAFF's muted is 2.52).*

### Hand-off and hardening
- [ ] **9. Robot access** — Google service account (read-only), sheet shared with it, pipeline
      switched to the Sheets API; then ask the client to set the sheet to Restricted.
      *Needs Jasmin: a Google Cloud project (free).*
- [ ] **10. Alert emails** — on problems, email Jasmin + the client's recruitment lead (who sees
      what is skipped and why). *Needs: the lead's email address, and a sender (Gmail app
      password or Resend free tier).*
- [ ] **11. Client guide** — one page: how a role appears on the site, what is never shown, the
      optional dropdown/number validation to add to the sheet, what the alert emails mean.
- [ ] **12. Workspace wiring** — add `hpg-jobs` to `helprof-brand/workspace/setup.*` and the
      routing table; record the decisions in `helprof-brand/CLAUDE.md` (open item 4 closes).

## Notes log
- 2026-10-12: every request date in the sheet is Apr–Jun 2026 while the roles are still ACTIVE,
  so a "Posted 4 months ago" label would undersell live roles. Task 7: show the date only when
  recent (≤ 30 days), otherwise nothing.
- 2026-10-12: plan written. MR sheet export works publicly (`/export?format=xlsx`). 22 ACTIVE
  roles at the time across the four tabs, ~15 distinct titles.
