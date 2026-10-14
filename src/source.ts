import { readFileSync } from 'node:fs'
import { accessToken, DRIVE_READONLY, parseKey } from './google.ts'

/**
 * Where the xlsx comes from, in order:
 *
 *   MR_XLSX                   a local file (testing)
 *   MR_SHEET_ID + GOOGLE_SA_KEY  the robot account, through the Drive API export
 *   MR_SHEET_ID               the public "anyone with the link" export (today)
 *
 * Drive's export endpoint, not the Sheets API: it returns the SAME xlsx the
 * public link does, so read.ts and its merged-cell handling are untouched.
 * The Sheets API would hand back values and merges in a different shape.
 */

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export type Env = Record<string, string | undefined>

export async function download(env: Env, fetchImpl: typeof fetch = fetch, log: (s: string) => void = console.log): Promise<Buffer> {
  if (env.MR_XLSX) return readFileSync(env.MR_XLSX)
  const id = env.MR_SHEET_ID
  if (!id) throw new Error('Set MR_SHEET_ID (or MR_XLSX for a local file).')

  let res: Response
  if (env.GOOGLE_SA_KEY) {
    log('Reading the sheet as the robot account (GOOGLE_SA_KEY).')
    const token = await accessToken(parseKey(env.GOOGLE_SA_KEY), DRIVE_READONLY, fetchImpl)
    res = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(XLSX)}`, { headers: { authorization: `Bearer ${token}` } })
    if (res.status === 404 || res.status === 403) {
      throw new Error(`Could not download the MR sheet (HTTP ${res.status}). Has the sheet been shared with the robot account's email (client_email in GOOGLE_SA_KEY) as a Viewer, and is the Drive API enabled in its Google Cloud project?`)
    }
  } else {
    log('Reading the sheet through its public link (no GOOGLE_SA_KEY set).')
    res = await fetchImpl(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/export?format=xlsx`, { redirect: 'follow' })
  }
  const type = res.headers.get('content-type') ?? ''
  // a sheet that is no longer shared answers 200 with a Google sign-in PAGE, not an error
  if (!res.ok || !type.includes('spreadsheetml')) throw new Error(`Could not download the MR sheet (HTTP ${res.status}, ${type || 'no type'}). Is it still shared "anyone with the link", or has the robot lost access?`)
  return Buffer.from(await res.arrayBuffer())
}
