import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { download } from '../src/source.ts'

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const answer = (body: string, status: number, type: string) => (async () => new Response(body, { status, headers: { 'content-type': type } })) as unknown as typeof fetch

describe('downloading the public sheet', () => {
  it('fetches the xlsx export with no credentials', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const f = (async (u: string | URL, init?: RequestInit) => (calls.push({ url: String(u), init }), new Response('xlsx-bytes', { headers: { 'content-type': XLSX } }))) as typeof fetch
    const buf = await download({ MR_SHEET_ID: 'abc' }, f)
    assert.equal(buf.toString(), 'xlsx-bytes')
    assert.equal(calls[0]!.url, 'https://docs.google.com/spreadsheets/d/abc/export?format=xlsx')
    assert.equal(calls[0]!.init?.headers, undefined, 'no authorization header')
  })

  it('says the sheet went private on a sign-in page, 401 or 403', async () => {
    for (const f of [answer('<html>', 200, 'text/html; charset=utf-8'), answer('', 401, 'text/html'), answer('', 403, 'text/html')]) {
      await assert.rejects(download({ MR_SHEET_ID: 'abc' }, f), /no longer public.*Anyone with the link/)
    }
  })

  it('says the id is wrong on 404', async () => {
    await assert.rejects(download({ MR_SHEET_ID: 'abc' }, answer('', 404, 'text/html')), /HTTP 404.*MR_SHEET_ID/)
  })

  it('needs an id', async () => {
    await assert.rejects(download({}), /Set MR_SHEET_ID/)
  })
})
