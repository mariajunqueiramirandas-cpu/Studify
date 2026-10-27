// An independent SigV4 query-signature check (what R2 does with a presigned URL), so the tests prove that a
// URL from r2Storage is accepted with the signed headers and refused with any other value.
import { createHash, createHmac } from 'node:crypto';

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: Buffer | string, s: string) => createHmac('sha256', key).update(s).digest();

export function verifyPresigned(raw: string, method: string, headers: Record<string, string>, secretAccessKey: string): boolean {
  const url = new URL(raw);
  const q = url.searchParams;
  const signature = q.get('X-Amz-Signature');
  const credential = q.get('X-Amz-Credential');
  const amzDate = q.get('X-Amz-Date');
  const signedHeaders = q.get('X-Amz-SignedHeaders');
  if (!signature || !credential || !amzDate || !signedHeaders) return false;
  const [, date, region, service] = credential.split('/');
  const query = [...q]
    .filter(([k]) => k !== 'X-Amz-Signature')
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const sent: Record<string, string> = { host: url.host };
  for (const [k, v] of Object.entries(headers)) sent[k.toLowerCase()] = v.trim();
  const names = signedHeaders.split(';');
  if (names.some((n) => sent[n] === undefined)) return false;
  const canonical = [method, url.pathname, query, names.map((n) => `${n}:${sent[n]}\n`).join(''), signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date ?? ''), region ?? ''), service ?? ''), 'aws4_request');
  return createHmac('sha256', kSigning).update(toSign).digest('hex') === signature;
}
