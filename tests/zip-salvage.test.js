/**
 * Tests for web/zip-salvage.js
 * Uses the REAL JSZip (no vi.mock) and byte-level fixtures built in code.
 */

import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import {
  crc32,
  salvageZip,
  loadZipWithRecovery,
  readVerifiedFile,
  formatSkippedNames,
  DAMAGED_ZIP_MESSAGE
} from '../web/zip-salvage.js';

const ZERO_SIGNATURE_ERROR =
  'Corrupted zip or bug: unexpected signature (\\x00\\x00\\x00\\x00, expected \\x50\\x4B\\x03\\x04)';

// ---------- fixture helpers ----------

/** Deterministic pseudo-random bytes (incompressible enough for DEFLATE tests) */
function pseudoRandomBytes(length, seed) {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

async function makeZip(files, options = {}) {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) {
    if (data === null) {
      zip.folder(name);
    } else {
      zip.file(name, data);
    }
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE', ...options });
}

const u16 = (d, o) => d[o] | (d[o + 1] << 8);
const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;

function withU32(bytes, offset, value) {
  const out = bytes.slice();
  new DataView(out.buffer).setUint32(offset, value, true);
  return out;
}

function withU16(bytes, offset, value) {
  const out = bytes.slice();
  new DataView(out.buffer).setUint16(offset, value, true);
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

function insertAt(bytes, position, insertion) {
  return concat(bytes.subarray(0, position), insertion, bytes.subarray(position));
}

function zeroRange(bytes, start, end) {
  const out = bytes.slice();
  out.fill(0, start, end);
  return out;
}

function findEocd(d) {
  for (let i = d.length - 22; i >= 0; i--) {
    if (u32(d, i) === 0x06054b50) return i;
  }
  throw new Error('no EOCD in fixture');
}

/** Layout of a well-formed fixture: EOCD position, CD offset, and local header offsets by name */
function layout(d) {
  const eocd = findEocd(d);
  const count = u16(d, eocd + 10);
  const cdOffset = u32(d, eocd + 16);
  const locals = {};
  const centrals = {};
  let p = cdOffset;
  for (let k = 0; k < count; k++) {
    const nameLength = u16(d, p + 28);
    const name = new TextDecoder().decode(d.subarray(p + 46, p + 46 + nameLength));
    locals[name] = u32(d, p + 42);
    centrals[name] = p;
    p += 46 + nameLength + u16(d, p + 30) + u16(d, p + 32);
  }
  return { eocd, cdOffset, locals, centrals };
}

async function expectZeroSignatureRejection(bytes) {
  await expect(new JSZip().loadAsync(bytes)).rejects.toThrow(ZERO_SIGNATURE_ERROR);
}

/** Read every entry of a recovered zip; returns {name: Uint8Array|null} */
async function readAll(result) {
  const out = {};
  for (const name of result.expectedCrc.keys()) {
    out[name] = await readVerifiedFile(result.zip, name, result.expectedCrc);
  }
  return out;
}

const PAGES = {
  'page1.jpg': pseudoRandomBytes(700, 1),
  'page2.jpg': pseudoRandomBytes(900, 2),
  'page3.jpg': pseudoRandomBytes(800, 3),
  'page4.png': pseudoRandomBytes(600, 4)
};

async function expectAllPagesRecovered(result, pages = PAGES) {
  expect(result.recovered).toBe(true);
  expect(result.skipped).toEqual([]);
  const contents = await readAll(result);
  expect(Object.keys(contents).sort()).toEqual(Object.keys(pages).sort());
  for (const [name, data] of Object.entries(pages)) {
    expect(contents[name]).toEqual(data);
  }
}

// ---------- tests ----------

describe('crc32', () => {
  it('matches known vectors', () => {
    const enc = new TextEncoder();
    expect(crc32(enc.encode('123456789'))).toBe(0xCBF43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(enc.encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414FA339);
  });

  it('matches the CRC JSZip stores in the central directory', async () => {
    const bytes = await makeZip({ 'a.jpg': PAGES['page1.jpg'] });
    const zip = await new JSZip().loadAsync(bytes);
    expect(crc32(PAGES['page1.jpg'])).toBe(zip.files['a.jpg']._data.crc32 >>> 0);
  });
});

describe('formatSkippedNames', () => {
  it('lists short lists in full', () => {
    expect(formatSkippedNames(['a.jpg', 'b.jpg'])).toBe('a.jpg, b.jpg');
  });

  it('truncates long lists', () => {
    const names = Array.from({ length: 15 }, (_, i) => `p${i}.jpg`);
    expect(formatSkippedNames(names, 3)).toBe('p0.jpg, p1.jpg, p2.jpg and 12 more');
  });
});

describe('loadZipWithRecovery: archives JSZip already handles (no salvage)', () => {
  it('loads a valid archive without salvage', async () => {
    const bytes = await makeZip(PAGES, { compression: 'DEFLATE' });
    const result = await loadZipWithRecovery(JSZip, bytes);
    expect(result.recovered).toBe(false);
    expect(result.skipped).toEqual([]);
    expect(result.expectedCrc).toBeNull();
    expect(Object.keys(result.zip.files).sort()).toEqual(Object.keys(PAGES).sort());
  });

  it('loads an archive with prepended data', async () => {
    const bytes = concat(pseudoRandomBytes(5000, 9), await makeZip(PAGES));
    const result = await loadZipWithRecovery(JSZip, bytes);
    expect(result.recovered).toBe(false);
    expect(await result.zip.file('page2.jpg').async('uint8array')).toEqual(PAGES['page2.jpg']);
  });

  it('loads an archive with trailing zeros', async () => {
    const bytes = concat(await makeZip(PAGES), new Uint8Array(3000));
    const result = await loadZipWithRecovery(JSZip, bytes);
    expect(result.recovered).toBe(false);
  });

  it('loads an archive with data descriptors (streamFiles)', async () => {
    const bytes = await makeZip(PAGES, { compression: 'DEFLATE', streamFiles: true });
    expect(u16(bytes, 6) & 0x0008).toBe(0x0008);
    const result = await loadZipWithRecovery(JSZip, bytes);
    expect(result.recovered).toBe(false);
    expect(await result.zip.file('page3.jpg').async('uint8array')).toEqual(PAGES['page3.jpg']);
  });

  it('loads an archive with __MACOSX entries', async () => {
    const bytes = await makeZip({ ...PAGES, '__MACOSX/._page1.jpg': new Uint8Array([1, 2, 3]) });
    const result = await loadZipWithRecovery(JSZip, bytes);
    expect(result.recovered).toBe(false);
    expect(result.zip.files['__MACOSX/._page1.jpg']).toBeDefined();
  });

  it('accepts an ArrayBuffer', async () => {
    const bytes = await makeZip(PAGES);
    const result = await loadZipWithRecovery(JSZip, bytes.buffer);
    expect(result.recovered).toBe(false);
  });
});

describe('loadZipWithRecovery: recoverable corruption', () => {
  it('recovers all entries when zeros are inserted before the central directory', async () => {
    const zip = await makeZip(PAGES, { compression: 'DEFLATE' });
    const { cdOffset } = layout(zip);
    const bytes = insertAt(zip, cdOffset, new Uint8Array(cdOffset + 4096));
    await expectZeroSignatureRejection(bytes);
    await expectAllPagesRecovered(await loadZipWithRecovery(JSZip, bytes));
  });

  it('recovers all entries when zeros are inserted between entries', async () => {
    const zip = await makeZip(PAGES);
    const { locals } = layout(zip);
    const bytes = insertAt(zip, locals['page2.jpg'], new Uint8Array(4096));
    await expectZeroSignatureRejection(bytes);
    await expectAllPagesRecovered(await loadZipWithRecovery(JSZip, bytes));
  });

  it('recovers a mixed SFX fix-up (EOCD offset adjusted, local offsets not)', async () => {
    const zip = await makeZip(PAGES);
    const stub = 2048;
    const { eocd, cdOffset } = layout(zip);
    const bytes = withU32(concat(new Uint8Array(stub), zip), stub + eocd + 16, cdOffset + stub);
    await expectZeroSignatureRejection(bytes);
    await expectAllPagesRecovered(await loadZipWithRecovery(JSZip, bytes));
  });

  it('recovers an archive with a ZIP64 EOCD record + locator but no 0xFFFF markers', async () => {
    // Info-ZIP "zip out.zip -" style: 76 bytes between the CD and the EOCD.
    // JSZip shifts every lookup by 76. The first CD record is exactly 76 bytes long
    // (30-byte name), so the shifted CD read lands on the second record, and the
    // second entry is stored zeros, so its shifted local lookup reads zeros.
    const longName = `${'x'.repeat(26)}.jpg`;
    const pages = { [longName]: PAGES['page1.jpg'], 'page2.jpg': new Uint8Array(300) };
    const zip = await makeZip(pages);
    const { eocd, cdOffset, locals } = layout(zip);
    expect(locals[longName]).toBe(0);
    expect(u32(zip, cdOffset + 76)).toBe(0x02014b50);
    const record = new Uint8Array(56);
    const rv = new DataView(record.buffer);
    rv.setUint32(0, 0x06064b50, true);
    rv.setBigUint64(4, 44n, true);
    rv.setUint16(12, 45, true);
    rv.setBigUint64(24, 2n, true);
    rv.setBigUint64(32, 2n, true);
    rv.setBigUint64(40, BigInt(eocd - cdOffset), true);
    rv.setBigUint64(48, BigInt(cdOffset), true);
    const locator = new Uint8Array(20);
    const lv = new DataView(locator.buffer);
    lv.setUint32(0, 0x07064b50, true);
    lv.setBigUint64(8, BigInt(eocd), true);
    lv.setUint32(16, 1, true);
    const bytes = insertAt(zip, eocd, concat(record, locator));

    await expectZeroSignatureRejection(bytes);
    await expectAllPagesRecovered(await loadZipWithRecovery(JSZip, bytes), pages);
  });

  it('recovers data-descriptor entries (local sizes are zero) using central directory sizes', async () => {
    const zip = await makeZip(PAGES, { compression: 'DEFLATE', streamFiles: true });
    const { cdOffset } = layout(zip);
    const bytes = insertAt(zip, cdOffset, new Uint8Array(cdOffset + 1024));
    await expectZeroSignatureRejection(bytes);
    await expectAllPagesRecovered(await loadZipWithRecovery(JSZip, bytes));

    const rebuilt = salvageZip(bytes).zipBytes;
    expect(u16(rebuilt, 6) & 0x0008).toBe(0);
    expect(u32(rebuilt, 18)).toBeGreaterThan(0);
  });

  it('keeps UTF-8 (non-ASCII) file names', async () => {
    const pages = { '사진_01.jpg': PAGES['page1.jpg'], 'émoji😀/페이지 2.png': PAGES['page2.jpg'] };
    const zip = await makeZip(pages);
    const { cdOffset } = layout(zip);
    const bytes = insertAt(zip, cdOffset, new Uint8Array(cdOffset + 512));
    await expectZeroSignatureRejection(bytes);
    const result = await loadZipWithRecovery(JSZip, bytes);
    await expectAllPagesRecovered(result, pages);
    expect(salvageZip(bytes).entries.map(e => e.name)).toEqual(Object.keys(pages));
  });

  it('keeps unicode path extra fields (non-UTF-8 encoded names)', async () => {
    const zip = await makeZip({ 'café.jpg': PAGES['page1.jpg'] }, {
      encodeFileName: name => new TextEncoder().encode(name.replace('é', 'e'))
    });
    const { cdOffset } = layout(zip);
    const bytes = insertAt(zip, cdOffset, new Uint8Array(cdOffset + 512));
    await expectZeroSignatureRejection(bytes);
    const result = await loadZipWithRecovery(JSZip, bytes);
    expect(result.recovered).toBe(true);
    expect(Object.keys(result.zip.files)).toEqual(['café.jpg']);
  });

  it('recovers directory entries', async () => {
    const pages = { 'chapter1/page1.jpg': PAGES['page1.jpg'], 'chapter1/page2.jpg': PAGES['page2.jpg'] };
    const zip = await makeZip({ 'chapter1/': null, ...pages });
    const { cdOffset } = layout(zip);
    const bytes = insertAt(zip, cdOffset, new Uint8Array(cdOffset + 512));
    await expectZeroSignatureRejection(bytes);
    const result = await loadZipWithRecovery(JSZip, bytes);
    await expectAllPagesRecovered(result, pages);
    expect(result.zip.files['chapter1/'].dir).toBe(true);
  });

  it('picks the right local header when two names share a prefix', async () => {
    const pages = {
      'page1.jpg': PAGES['page1.jpg'],
      'page1.jpg.bak': PAGES['page2.jpg'],
      'page1.jp': PAGES['page3.jpg']
    };
    // Mixed SFX fix-up forces the name lookup for every entry
    const zip = await makeZip(pages);
    const { eocd, cdOffset } = layout(zip);
    const bytes = withU32(concat(new Uint8Array(100), zip), 100 + eocd + 16, cdOffset + 100);
    await expectZeroSignatureRejection(bytes);
    await expectAllPagesRecovered(await loadZipWithRecovery(JSZip, bytes), pages);
  });
});

describe('loadZipWithRecovery: partial recovery', () => {
  it('skips an entry whose local header is zeroed', async () => {
    const zip = await makeZip(PAGES);
    const { locals } = layout(zip);
    const bytes = zeroRange(zip, locals['page3.jpg'], locals['page3.jpg'] + 30);
    await expectZeroSignatureRejection(bytes);

    const result = await loadZipWithRecovery(JSZip, bytes);
    expect(result.recovered).toBe(true);
    expect(result.skipped).toEqual(['page3.jpg']);
    const contents = await readAll(result);
    expect(Object.keys(contents).sort()).toEqual(['page1.jpg', 'page2.jpg', 'page4.png']);
    expect(contents['page4.png']).toEqual(PAGES['page4.png']);
  });

  it('reports a damaged data region through a CRC mismatch', async () => {
    const zip = await makeZip(PAGES);
    const { locals } = layout(zip);
    // Zero from the middle of page2's data through page3's local header
    const bytes = zeroRange(zip, locals['page3.jpg'] - 200, locals['page3.jpg'] + 30);
    await expectZeroSignatureRejection(bytes);

    const result = await loadZipWithRecovery(JSZip, bytes);
    expect(result.skipped).toEqual(['page3.jpg']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const contents = await readAll(result);
    warn.mockRestore();
    expect(contents['page2.jpg']).toBeNull();
    expect(contents['page1.jpg']).toEqual(PAGES['page1.jpg']);
    expect(contents['page4.png']).toEqual(PAGES['page4.png']);
  });

  it('does not report a lost directory entry as skipped', async () => {
    const zip = await makeZip({ 'dir/': null, 'dir/page1.jpg': PAGES['page1.jpg'] });
    const { locals } = layout(zip);
    const bytes = zeroRange(zip, locals['dir/'], locals['dir/'] + 30);
    await expectZeroSignatureRejection(bytes);
    const result = await loadZipWithRecovery(JSZip, bytes);
    expect(result.skipped).toEqual([]);
    expect(Object.keys(result.zip.files)).toEqual(['dir/page1.jpg']);
  });
});

describe('loadZipWithRecovery: unrecoverable archives', () => {
  it('throws a friendly error when everything before the central directory is zeroed', async () => {
    const zip = await makeZip(PAGES);
    const { cdOffset } = layout(zip);
    const bytes = zeroRange(zip, 0, cdOffset);
    await expectZeroSignatureRejection(bytes);

    const error = await loadZipWithRecovery(JSZip, bytes).catch(e => e);
    expect(error.message).toBe(DAMAGED_ZIP_MESSAGE);
    expect(error.message).toMatch(/not fully downloaded/);
    expect(error.cause.message).toBe(ZERO_SIGNATURE_ERROR);
  });

  it('throws a friendly error for a truncated file (EOCD missing), keeping the JSZip error as cause', async () => {
    const zip = await makeZip(PAGES);
    const bytes = zip.slice(0, Math.floor(zip.length / 2));
    const error = await loadZipWithRecovery(JSZip, bytes).catch(e => e);
    expect(error.message).toBe(DAMAGED_ZIP_MESSAGE);
    expect(error.cause.message).toMatch(/end of central directory/);
  });

  it('throws a friendly error for random garbage', async () => {
    const error = await loadZipWithRecovery(JSZip, pseudoRandomBytes(4096, 7)).catch(e => e);
    expect(error.message).toBe(DAMAGED_ZIP_MESSAGE);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('salvageZip returns null zipBytes when nothing is recoverable', () => {
    expect(salvageZip(pseudoRandomBytes(1000, 3)))
      .toEqual({ zipBytes: null, entries: [], skipped: [], lostCount: 0 });
  });
});

describe('loadZipWithRecovery: non-corruption errors', () => {
  it('propagates non-corruption errors unchanged', async () => {
    const original = new Error('Something else went wrong');
    class FailingZip {
      loadAsync() {
        return Promise.reject(original);
      }
    }
    await expect(loadZipWithRecovery(FailingZip, new Uint8Array(10))).rejects.toBe(original);
  });

  it('propagates JSZip errors for encrypted archives unchanged', async () => {
    const zip = await makeZip({ 'a.jpg': PAGES['page1.jpg'] });
    const { cdOffset } = layout(zip);
    const bytes = withU16(withU16(zip, 6, 1), cdOffset + 8, 1);
    await expect(loadZipWithRecovery(JSZip, bytes)).rejects.toThrow('Encrypted zip are not supported');
  });

  it('rethrows the original error when the input cannot be read as bytes', async () => {
    const original = new Error('Corrupted zip: test');
    class FailingZip {
      loadAsync() {
        return Promise.reject(original);
      }
    }
    await expect(loadZipWithRecovery(FailingZip, 'not bytes')).rejects.toBe(original);
  });
});

describe('salvageZip', () => {
  it('returns the entries with central directory CRC and size', async () => {
    const zip = await makeZip(PAGES);
    const { cdOffset } = layout(zip);
    const bytes = insertAt(zip, cdOffset, new Uint8Array(cdOffset + 16));
    const { entries, skipped } = salvageZip(bytes);
    expect(skipped).toEqual([]);
    expect(entries).toEqual(Object.entries(PAGES).map(([name, data]) => ({
      name,
      crc32: crc32(data),
      uncompressedSize: data.length
    })));
  });

  it('produces an archive that plain JSZip loads', async () => {
    const zip = await makeZip(PAGES, { compression: 'DEFLATE' });
    const { locals } = layout(zip);
    const bytes = insertAt(zip, locals['page3.jpg'], new Uint8Array(5000));
    const loaded = await new JSZip().loadAsync(salvageZip(bytes).zipBytes, { checkCRC32: true });
    expect(await loaded.file('page3.jpg').async('uint8array')).toEqual(PAGES['page3.jpg']);
  });
});

/** Prepend a stub and fix only the EOCD CD offset, so every local offset is wrong */
function mixedSfx(zip, stub) {
  const { eocd, cdOffset } = layout(zip);
  return withU32(concat(stub, zip), stub.length + eocd + 16, cdOffset + stub.length);
}

/** Insert zeros right before the central directory (salvage needed, offsets right) */
function gapBeforeCd(zip, size = 4096) {
  return insertAt(zip, layout(zip).cdOffset, new Uint8Array(size));
}

describe('salvage: review regressions', () => {
  it('skips entries with a compression method JSZip cannot read and keeps the rest', async () => {
    const pages = { 'a.jpg': PAGES['page1.jpg'], 'b.jpg': PAGES['page2.jpg'], 'c.jpg': PAGES['page3.jpg'] };
    const zip = await makeZip(pages);
    const { locals, centrals } = layout(zip);
    const bzip2 = withU16(withU16(zip, locals['b.jpg'] + 8, 12), centrals['b.jpg'] + 10, 12);
    await expect(new JSZip().loadAsync(bzip2)).rejects.toThrow(/compression .* unknown/);

    for (const bytes of [bzip2, gapBeforeCd(bzip2)]) {
      const result = await loadZipWithRecovery(JSZip, bytes);
      expect(result.recovered).toBe(true);
      expect(result.skipped).toEqual(['b.jpg']);
      const contents = await readAll(result);
      expect(contents).toEqual({ 'a.jpg': pages['a.jpg'], 'c.jpg': pages['c.jpg'] });
    }
  });

  it('reads past a damaged central directory record and counts the lost entry', async () => {
    const pages = Object.fromEntries(
      [1, 2, 3, 4, 5, 6].map(n => [`page${n}.jpg`, pseudoRandomBytes(300, n)]));
    const zip = await makeZip(pages);
    const { centrals } = layout(zip);
    const bytes = gapBeforeCd(zeroRange(zip, centrals['page3.jpg'], centrals['page3.jpg'] + 46));
    await expect(new JSZip().loadAsync(bytes)).rejects.toThrow(/Corrupted zip/);

    const result = await loadZipWithRecovery(JSZip, bytes);
    expect(result.lostCount).toBe(1);
    expect(result.skipped).toEqual([]);
    const { 'page3.jpg': _lost, ...rest } = pages;
    expect(await readAll(result)).toEqual(rest);
  });

  it('finds the EOCD behind more than 64KB of trailing zeros', async () => {
    const zip = await makeZip(PAGES);
    const { cdOffset } = layout(zip);
    const bytes = concat(insertAt(zip, cdOffset, new Uint8Array(cdOffset + 4096)), new Uint8Array(70000));
    await expectZeroSignatureRejection(bytes);
    await expectAllPagesRecovered(await loadZipWithRecovery(JSZip, bytes));
  });

  it('rejects overlapping entries so the rebuilt archive is never larger than the input', async () => {
    const zip = await makeZip(PAGES);
    const { cdOffset, centrals } = layout(zip);
    // page1 claims all data up to the central directory
    const overlapping = withU32(zip, centrals['page1.jpg'] + 20, cdOffset - 30 - 'page1.jpg'.length);
    const bytes = gapBeforeCd(overlapping, cdOffset + 4096);
    await expectZeroSignatureRejection(bytes);

    const { zipBytes, skipped } = salvageZip(bytes);
    expect(zipBytes.length).toBeLessThanOrEqual(bytes.length);
    expect(skipped.sort()).toEqual(['page2.jpg', 'page3.jpg', 'page4.png']);
  });

  it('indexes headers with huge name lengths quickly', async () => {
    const region = new Uint8Array(65536);
    for (let i = 0; i + 30 <= region.length; i += 32) {
      region.set([0x50, 0x4B, 0x03, 0x04], i);
      region[i + 26] = 0xFF;
      region[i + 27] = 0xFF;
    }
    const bytes = mixedSfx(await makeZip(PAGES), concat(region, new Uint8Array(70000)));
    await expect(new JSZip().loadAsync(bytes)).rejects.toThrow(/Corrupted zip/);

    const start = Date.now();
    const { entries, skipped } = salvageZip(bytes);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(skipped).toEqual([]);
    expect(entries.map(e => e.name)).toEqual(Object.keys(PAGES));
  });

  it('indexes many headers with the same name in linear time', async () => {
    const fake = concat(new Uint8Array([0x50, 0x4B, 0x03, 0x04]), new Uint8Array(22),
      new Uint8Array([9, 0, 0, 0]), new TextEncoder().encode('page2.jpg'));
    const region = new Uint8Array(fake.length * 80000);
    for (let i = 0; i < 80000; i++) region.set(fake, i * fake.length);
    const bytes = mixedSfx(await makeZip(PAGES), region);

    const start = Date.now();
    const { entries } = salvageZip(bytes);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(entries.map(e => e.name)).toEqual(Object.keys(PAGES));
  });

  it('returns null from readVerifiedFile when a DEFLATE stream cannot be inflated', async () => {
    const zip = await makeZip(PAGES, { compression: 'DEFLATE' });
    const { locals } = layout(zip);
    const dataStart = locals['page2.jpg'] + 30 + 'page2.jpg'.length;
    const bytes = gapBeforeCd(zeroRange(zip, dataStart, dataStart + 8), layout(zip).cdOffset + 4096);
    await expectZeroSignatureRejection(bytes);

    const result = await loadZipWithRecovery(JSZip, bytes);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const contents = await readAll(result);
    expect(warn).toHaveBeenCalledWith('Skipping damaged file: page2.jpg', expect.anything());
    warn.mockRestore();
    expect(contents['page2.jpg']).toBeNull();
    expect(contents['page1.jpg']).toEqual(PAGES['page1.jpg']);
  });

  it('resolves sizes from a ZIP64 extra field in the central directory', async () => {
    const data = PAGES['page1.jpg'];
    const zip = await makeZip({ 'a.jpg': data });
    const { eocd, cdOffset } = layout(zip);
    const nameLength = u16(zip, cdOffset + 28);
    const header = withU32(withU32(withU16(zip.slice(cdOffset, cdOffset + 46), 30, 20), 20, 0xFFFFFFFF), 24, 0xFFFFFFFF);
    const extra = new Uint8Array(20);
    const ev = new DataView(extra.buffer);
    ev.setUint16(0, 0x0001, true);
    ev.setUint16(2, 16, true);
    ev.setBigUint64(4, BigInt(data.length), true);
    ev.setBigUint64(12, BigInt(data.length), true);
    const cd = concat(header, zip.subarray(cdOffset + 46, cdOffset + 46 + nameLength), extra);
    const end = withU32(zip.slice(eocd), 12, cd.length);
    const bytes = concat(zip.subarray(0, cdOffset), new Uint8Array(4096), cd, end);
    await expectZeroSignatureRejection(bytes);

    const result = await loadZipWithRecovery(JSZip, bytes);
    expect(result.skipped).toEqual([]);
    expect(await readAll(result)).toEqual({ 'a.jpg': data });
  });
});
