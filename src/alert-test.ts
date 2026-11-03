import { addresses, mailerFromEnv } from './alert.ts'

/**
 * npm run alert:test
 *
 * Sends one plain "this is a test" email to ALERT_TO_TEAM (and ALERT_TO with
 * TEST_ALERT_ALL=1), to prove the sender secrets work. No sheet, no feed, no
 * alert state. Run it from Actions > sync > Run workflow > "test_alert".
 * Fails (red run) when it cannot send, so a broken sender is visible.
 */
async function main() {
  const mailer = mailerFromEnv(process.env)
  if (!mailer) throw new Error('No sender: set SMTP_USER + SMTP_PASS (or RESEND_API_KEY + ALERT_FROM).')
  const to = addresses([process.env.ALERT_TO_TEAM, process.env.TEST_ALERT_ALL === '1' ? process.env.ALERT_TO : ''].join(','))
  if (to.length === 0) throw new Error('No recipients: set ALERT_TO_TEAM.')
  await mailer.send({
    to,
    subject: 'HPG job board: test alert',
    text: 'This is a test from the hpg-jobs sync. If you can read it, alert emails work.\n\nNothing needs doing.',
  })
  console.log(`Test alert sent via ${mailer.name} to ${to.length} address(es).`)
}

main().catch((e: unknown) => {
  console.error(`Test alert failed: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
