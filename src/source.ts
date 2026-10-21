import { readFileSync } from 'node:fs'

/**
 * Where the xlsx comes from:
 *
 *   MR_XLSX      a local file (testing)
 *   MR_SHEET_ID  the sheet's public "anyone with the link" export - no credentials
 *
 * One xlsx export of the whole workbook, not a CSV/gviz export per tab: CSV
 * drops merged cells, and read.ts finds a request block by its merges. A tab
 * that is renamed or deleted is caught there (held, last good list kept).
 *
 * The client keeps the sheet public (decision 2026-10-21), so the read-only
 * service account (old task 9) was removed. It is in git history (src/google.ts,
 * before this commit) if the client ever wants the sheet Restricted.
 */

export type Env = Record<string, string | undefined>

export const exportUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/export?format=xlsx`

export async function download(env: Env, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  if (env.MR_XLSX) return readFileSync(env.MR_XLSX)
  const id = env.MR_SHEET_ID?.trim()
  if (!id) throw new Error('Set MR_SHEET_ID (or MR_XLSX for a local file).')

  const res = await fetchImpl(exportUrl(id), { redirect: 'follow' })
  const type = res.headers.get('content-type') ?? ''
  if (res.status === 404) throw new Error('Could not download the MR sheet (HTTP 404). Is MR_SHEET_ID right, and does the sheet still exist?')
  // a sheet that is no longer public answers 401/403, or 200 with a Google sign-in PAGE
  if (res.status === 401 || res.status === 403 || (res.ok && type.includes('text/html'))) {
    throw new Error(`Could not download the MR sheet (HTTP ${res.status}): Google asked to sign in, so the sheet is no longer public. Ask the client to set Share > General access back to "Anyone with the link" (Viewer).`)
  }
  if (!res.ok || !type.includes('spreadsheetml')) throw new Error(`Could not download the MR sheet (HTTP ${res.status}, ${type || 'no type'}).`)
  return Buffer.from(await res.arrayBuffer())
}
