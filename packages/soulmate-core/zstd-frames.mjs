// Multi-frame zstd reader for DSH session logs.
//
// Session files are append-only zstd: every flush adds a NEW frame. Node ≥24.22's
// zstdDecompressSync concatenates all frames, but the DSH runtime ships 24.21 which
// stops after the FIRST frame — silently returning 227 bytes of a 1.6MB log. That
// made the QQ bridge import nothing and the speaker list come back empty on the
// real host while working on the dev machine. Split on the zstd magic and decode
// frame-by-frame so both runtimes agree.

import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function zstdDecodeAll(buf) {
  const starts = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) >= 0) { starts.push(i); i += 4; }
  if (starts.length <= 1) return zlib.zstdDecompressSync(buf).toString('utf8');
  let out = '';
  for (let k = 0; k < starts.length; k++) {
    const chunk = buf.slice(starts[k], starts[k + 1] ?? buf.length);
    try { out += zlib.zstdDecompressSync(chunk).toString('utf8'); } catch { /* torn tail frame */ }
  }
  return out;
}