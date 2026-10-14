import assert from 'node:assert/strict'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { describe, it } from 'node:test'
import { accessToken, DRIVE_READONLY, parseKey, signedJwt, TOKEN_URL } from '../src/google.ts'
import { download } from '../src/source.ts'

// a throwaway key, made for this test run only
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const KEY = { client_email: 'robot@example.iam.gserviceaccount.com', private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
const KEY_JSON = JSON.stringify({ type: 'service_account', ...KEY })
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>

describe('robot sign-in (task 9)', () => {
  it('builds an RS256 JWT with the claims Google expects', () => {
    const jwt = signedJwt(KEY, DRIVE_READONLY, 1_700_000_000)
    const parts = jwt.split('.')
    assert.equal(parts.length, 3)
    for (const p of parts) assert.match(p, /^[A-Za-z0-9_-]+$/, 'base64url: no +, / or = padding')
    assert.deepEqual(decode(parts[0]!), { alg: 'RS256', typ: 'JWT' })
    assert.deepEqual(decode(parts[1]!), { iss: KEY.client_email, scope: DRIVE_READONLY, aud: TOKEN_URL, iat: 1_700_000_000, exp: 1_700_003_600 })
    const ok = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(pair.publicKey, Buffer.from(parts[2]!, 'base64url'))
    assert.ok(ok, 'signature verifies with the public half')
  })

  it('rejects a bad key without echoing it', () => {
    for (const bad of ['not json {secret-ish', JSON.stringify({ client_id: 'x', secret: 'hush' })]) {
      assert.throws(() => parseKey(bad), (e: Error) => !e.message.includes('secret') && /GOOGLE_SA_KEY/.test(e.message))
    }
  })

  it('exchanges the JWT for a token, and reports a refusal without the body', async () => {
    let sent = ''
    const good = (async (_u: unknown, init?: RequestInit) => {
      sent = String(init?.body)
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })
    }) as typeof fetch
    assert.equal(await accessToken(KEY, DRIVE_READONLY, good), 'tok')
    assert.match(sent, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=/)
    const refused = (async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'details' }), { status: 400 })) as typeof fetch
    await assert.rejects(accessToken(KEY, DRIVE_READONLY, refused), /HTTP 400, invalid_grant/)
  })
})

describe('downloading the sheet', () => {
  const quiet = () => {}

  it('uses the Drive export with a bearer token when GOOGLE_SA_KEY is set', async () => {
    const calls: Array<{ url: string; auth?: string }> = []
    const f = (async (u: string | URL, init?: RequestInit) => {
      const url = String(u)
      calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization })
      if (url === TOKEN_URL) return new Response(JSON.stringify({ access_token: 'tok' }))
      return new Response('xlsx-bytes', { headers: { 'content-type': XLSX } })
    }) as typeof fetch
    const buf = await download({ MR_SHEET_ID: 'abc', GOOGLE_SA_KEY: KEY_JSON }, f, quiet)
    assert.equal(buf.toString(), 'xlsx-bytes')
    assert.equal(calls[1]!.url, `https://www.googleapis.com/drive/v3/files/abc/export?mimeType=${encodeURIComponent(XLSX)}`)
    assert.equal(calls[1]!.auth, 'Bearer tok')
  })

  it('keeps the public link when there is no key', async () => {
    const urls: string[] = []
    const f = (async (u: string | URL) => (urls.push(String(u)), new Response('x', { headers: { 'content-type': XLSX } }))) as typeof fetch
    await download({ MR_SHEET_ID: 'abc' }, f, quiet)
    assert.deepEqual(urls, ['https://docs.google.com/spreadsheets/d/abc/export?format=xlsx'])
  })

  it('refuses a sign-in page on either path', async () => {
    const page = (async (u: string | URL) => (String(u) === TOKEN_URL ? new Response(JSON.stringify({ access_token: 't' })) : new Response('<html>', { headers: { 'content-type': 'text/html' } }))) as typeof fetch
    await assert.rejects(download({ MR_SHEET_ID: 'abc' }, page, quiet), /Could not download/)
    await assert.rejects(download({ MR_SHEET_ID: 'abc', GOOGLE_SA_KEY: KEY_JSON }, page, quiet), /Could not download/)
  })

  it('says to share the sheet with the robot when Drive answers 404', async () => {
    const f = (async (u: string | URL) => (String(u) === TOKEN_URL ? new Response(JSON.stringify({ access_token: 't' })) : new Response('{}', { status: 404 }))) as typeof fetch
    await assert.rejects(download({ MR_SHEET_ID: 'abc', GOOGLE_SA_KEY: KEY_JSON }, f, quiet), /shared with the robot/)
  })
})
