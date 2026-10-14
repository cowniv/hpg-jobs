import { createSign } from 'node:crypto'

/**
 * Signs in to Google as the read-only service account (PLAN.md task 9) with
 * nothing but node:crypto: an RS256-signed JWT is exchanged for a one-hour
 * access token. No Google SDK - it would be ~40MB of dependency for two calls.
 *
 * NEVER log the key, the assertion or the token: this repo's Action logs are
 * public. Error messages here carry status codes and Google's error CODE only.
 */

export const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const DRIVE_READONLY = 'https://www.googleapis.com/auth/drive.readonly'

/** The fields of a service-account JSON key this needs. */
export interface ServiceAccountKey {
  client_email: string
  private_key: string
  token_uri?: string
}

/** Parses GOOGLE_SA_KEY. Never echoes the input back, even partly. */
export function parseKey(raw: string): ServiceAccountKey {
  let k: Partial<ServiceAccountKey>
  try {
    k = JSON.parse(raw) as Partial<ServiceAccountKey>
  } catch {
    throw new Error('GOOGLE_SA_KEY is not valid JSON. Paste the whole service-account key file, from { to }.')
  }
  if (typeof k.client_email !== 'string' || typeof k.private_key !== 'string' || !k.private_key.includes('PRIVATE KEY')) {
    throw new Error('GOOGLE_SA_KEY is missing client_email or private_key. Use the JSON key of a SERVICE ACCOUNT (not an OAuth client).')
  }
  return { client_email: k.client_email, private_key: k.private_key, token_uri: k.token_uri }
}

export const base64url = (b: Buffer | string) => Buffer.from(b).toString('base64url')

/** The signed JWT Google's token endpoint accepts. `now` in seconds. */
export function signedJwt(key: ServiceAccountKey, scope: string, now: number): string {
  const header = { alg: 'RS256', typ: 'JWT' }
  const claims = { iss: key.client_email, scope, aud: key.token_uri ?? TOKEN_URL, iat: now, exp: now + 3600 }
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key)
  return `${unsigned}.${base64url(signature)}`
}

/** Exchanges the signed JWT for an access token. */
export async function accessToken(key: ServiceAccountKey, scope: string, fetchImpl: typeof fetch = fetch, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const res = await fetchImpl(key.token_uri ?? TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedJwt(key, scope, now) }).toString(),
  })
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string }
  if (!res.ok || !body.access_token) {
    throw new Error(`Google sign-in for the robot account failed (HTTP ${res.status}${body.error ? `, ${body.error}` : ''}). Is GOOGLE_SA_KEY a current key of an existing service account?`)
  }
  return body.access_token
}
