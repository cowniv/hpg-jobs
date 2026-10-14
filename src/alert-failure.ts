import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { deliverFailureAlert, ERROR_FILE, loadState, mailerFromEnv, runUrl, saveState } from './alert.ts'

/**
 * npm run alert:failure
 *
 * The workflow's "if the sync failed" step. Emails ALERT_TO_TEAM what went
 * wrong (the error sync.ts left in .cache/sync-error.txt), once per distinct
 * error plus a weekly reminder - not every 30 minutes. The next successful sync
 * sends "working again". Never fails the step itself: the run is already red.
 */

async function main() {
  const error = existsSync(ERROR_FILE)
    ? readFileSync(ERROR_FILE, 'utf8').trim()
    : 'The run stopped before the sync finished (an earlier step such as the tests failed). See the run log.'
  const res = await deliverFailureAlert({ env: process.env, state: loadState(), error, mailer: mailerFromEnv(process.env), now: new Date(), runUrl: runUrl(process.env) })
  if (res.changed) saveState(res.state)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `alert_state=${res.changed}\n`)
}

main().catch((e: unknown) => {
  console.error(`Could not send the failure alert: ${e instanceof Error ? e.message : String(e)}`)
})
