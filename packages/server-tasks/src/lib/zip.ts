// Minimal store-only ZIP writer (no compression, CRC-32 checksums). Used for account exports
// (SP-14): no zip dependency is installed in the worker, and the export is small JSON + CSV.
// Timestamps are fixed to 1980-01-01 so the same input always produces the same bytes.

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0;
// 1980-01-01 → (0 << 9) | (1 << 5) | 1
const DOS_DATE = 0x21;

function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

/** Builds a ZIP archive (PKZIP 2.0, method 0 = stored) from the given entries, in order. */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const prepared = entries.map((entry) => {
    const name = encoder.encode(entry.name);
    return { name, data: entry.data, crc: crc32(entry.data) };
  });

  let localSize = 0;
  let centralSize = 0;
  for (const p of prepared) {
    localSize += 30 + p.name.length + p.data.length;
    centralSize += 46 + p.name.length;
  }
  const endSize = 22;
  const out = new Uint8Array(localSize + centralSize + endSize);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];

  let pos = 0;
  for (const p of prepared) {
    offsets.push(pos);
    u32(view, pos, 0x04034b50);
    u16(view, pos + 4, 20); // version needed
    u16(view, pos + 6, 0x0800); // UTF-8 names
    u16(view, pos + 8, 0); // method: stored
    u16(view, pos + 10, DOS_TIME);
    u16(view, pos + 12, DOS_DATE);
    u32(view, pos + 14, p.crc);
    u32(view, pos + 18, p.data.length);
    u32(view, pos + 22, p.data.length);
    u16(view, pos + 26, p.name.length);
    u16(view, pos + 28, 0);
    out.set(p.name, pos + 30);
    out.set(p.data, pos + 30 + p.name.length);
    pos += 30 + p.name.length + p.data.length;
  }

  const centralStart = pos;
  prepared.forEach((p, i) => {
    u32(view, pos, 0x02014b50);
    u16(view, pos + 4, 20); // version made by
    u16(view, pos + 6, 20); // version needed
    u16(view, pos + 8, 0x0800);
    u16(view, pos + 10, 0);
    u16(view, pos + 12, DOS_TIME);
    u16(view, pos + 14, DOS_DATE);
    u32(view, pos + 16, p.crc);
    u32(view, pos + 20, p.data.length);
    u32(view, pos + 24, p.data.length);
    u16(view, pos + 28, p.name.length);
    u16(view, pos + 30, 0);
    u16(view, pos + 32, 0);
    u16(view, pos + 34, 0);
    u16(view, pos + 36, 0);
    u32(view, pos + 38, 0);
    u32(view, pos + 42, offsets[i] ?? 0);
    out.set(p.name, pos + 46);
    pos += 46 + p.name.length;
  });

  u32(view, pos, 0x06054b50);
  u16(view, pos + 4, 0);
  u16(view, pos + 6, 0);
  u16(view, pos + 8, prepared.length);
  u16(view, pos + 10, prepared.length);
  u32(view, pos + 12, pos - centralStart);
  u32(view, pos + 16, centralStart);
  u16(view, pos + 20, 0);
  return out;
}

/** CSV with a header row; values are quoted when needed and use CRLF line endings (RFC 4180). */
export function toCsv(columns: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.map(escape).join(',')];
  for (const row of rows) lines.push(columns.map((c) => escape(row[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}
