/**
 * App-level tests for damaged ZIP recovery in web/app.js (extractImagesFromZip).
 * Loads the real browser scripts (sorting-logic.js, zip-salvage.js, app.js) with the REAL JSZip.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import JSZip from 'jszip';

const root = resolve(__dirname, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');

let extractImagesFromZip;
let app;

beforeAll(() => {
  // index.html body provides the elements init() looks up
  const html = read('web/index.html');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));

  const source = [
    read('shared/sorting-logic.js'),
    read('web/zip-salvage.js'),
    read('web/app.js'),
    // PDF rendering is out of scope here
    'convertImagesToPDF = async () => {};',
    'return { extractImagesFromZip, convertAllZipsIndividually, convertAllZipsToSinglePDF, state };'
  ].join('\n');
  // `module` is undefined so the scripts behave as browser globals
  app = new Function('JSZip', 'module', source)(JSZip, undefined);
  ({ extractImagesFromZip } = app);
});

/** jsdom's File has no arrayBuffer(); browsers do */
function makeFile(bytes, name) {
  const file = new File([bytes], name);
  file.arrayBuffer = () => Promise.resolve(bytes.slice().buffer);
  return file;
}

function pseudoRandomBytes(length, seed) {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const u16 = (d, o) => d[o] | (d[o + 1] << 8);
const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;

/** Local header offsets by name, read from the central directory of a well-formed zip */
function localOffsets(d) {
  let eocd = d.length - 22;
  while (u32(d, eocd) !== 0x06054b50) eocd--;
  const offsets = {};
  let p = u32(d, eocd + 16);
  for (let k = 0; k < u16(d, eocd + 10); k++) {
    const nameLength = u16(d, p + 28);
    offsets[new TextDecoder().decode(d.subarray(p + 46, p + 46 + nameLength))] = u32(d, p + 42);
    p += 46 + nameLength + u16(d, p + 30) + u16(d, p + 32);
  }
  return offsets;
}

async function makeZip(files) {
  const zip = new JSZip();
  Object.entries(files).forEach(([name, data]) => zip.file(name, data));
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
}

describe('extractImagesFromZip with damaged archives', () => {
  it('extracts a valid archive with no recovery warning', async () => {
    const bytes = await makeZip({ 'p2.jpg': pseudoRandomBytes(300, 2), 'p1.jpg': pseudoRandomBytes(300, 1) });
    const images = await extractImagesFromZip(makeFile(bytes, 'book.zip'));
    expect(images.map(i => i.filename)).toEqual(['p1.jpg', 'p2.jpg']);
    expect(images.recoveryWarning).toBeUndefined();
  });

  it('extracts sorted images from a repaired archive and adds a warning', async () => {
    const zip = await makeZip({
      'p10.jpg': pseudoRandomBytes(300, 3),
      'p2.jpg': pseudoRandomBytes(300, 2),
      'p1.jpg': pseudoRandomBytes(300, 1)
    });
    const { 'p2.jpg': p2 } = localOffsets(zip);
    const bytes = new Uint8Array([...zip.subarray(0, p2), ...new Uint8Array(4096), ...zip.subarray(p2)]);
    await expect(new JSZip().loadAsync(bytes)).rejects.toThrow(/unexpected signature/);

    const images = await extractImagesFromZip(makeFile(bytes, 'book.zip'));
    expect(images.map(i => i.filename)).toEqual(['p1.jpg', 'p2.jpg', 'p10.jpg']);
    expect(images.recoveryWarning).toBe('book.zip was damaged and has been repaired.');
  });

  it('skips images with a zeroed header or a bad CRC and lists them', async () => {
    const zip = await makeZip({
      'p1.jpg': pseudoRandomBytes(300, 1),
      'p2.jpg': pseudoRandomBytes(300, 2),
      'p3.jpg': pseudoRandomBytes(300, 3),
      'p4.jpg': pseudoRandomBytes(300, 4)
    });
    const { 'p3.jpg': p3 } = localOffsets(zip);
    const bytes = zip.slice();
    bytes.fill(0, p3 - 100, p3 + 30); // damages p2's data and p3's header

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const images = await extractImagesFromZip(makeFile(bytes, 'book.zip'));
    warn.mockRestore();

    expect(images.map(i => i.filename)).toEqual(['p1.jpg', 'p4.jpg']);
    expect(images.recoveryWarning).toBe('book.zip is damaged. Skipped 2 image(s): p3.jpg, p2.jpg');
  });

  it('still applies format filtering to recovered archives', async () => {
    const zip = await makeZip({ 'p1.jpg': pseudoRandomBytes(300, 2), 'p2.bmp': pseudoRandomBytes(300, 3) });
    const { 'p2.bmp': p2 } = localOffsets(zip);
    const bytes = new Uint8Array([...zip.subarray(0, p2), ...new Uint8Array(4096), ...zip.subarray(p2)]);
    await expect(new JSZip().loadAsync(bytes)).rejects.toThrow(/unexpected signature/);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const images = await extractImagesFromZip(makeFile(bytes, 'book.zip'));
    warn.mockRestore();
    expect(images.map(i => i.filename)).toEqual(['p1.jpg']);
    expect(images.recoveryWarning).toBe('book.zip was damaged and has been repaired.');
  });

  it('still applies the extraction size limit to recovered archives', async () => {
    const zip = await makeZip({ 'p1.jpg': pseudoRandomBytes(300, 1) });
    let eocd = zip.length - 22;
    while (u32(zip, eocd) !== 0x06054b50) eocd--;
    const cdOffset = u32(zip, eocd + 16);
    const bytes = new Uint8Array([...zip.subarray(0, cdOffset), ...new Uint8Array(4096), ...zip.subarray(cdOffset)]);
    // Claim 600MB uncompressed in the central directory record
    new DataView(bytes.buffer).setUint32(cdOffset + 4096 + 24, 600 * 1024 * 1024, true);
    await expect(new JSZip().loadAsync(bytes)).rejects.toThrow(/unexpected signature/);

    await expect(extractImagesFromZip(makeFile(bytes, 'book.zip')))
      .rejects.toThrow(/maximum extraction size/);
  });

  it('throws the friendly error when nothing can be recovered', async () => {
    const zip = await makeZip({ 'p1.jpg': pseudoRandomBytes(300, 1) });
    const bytes = zip.slice();
    bytes.fill(0, 0, 30);
    await expect(extractImagesFromZip(makeFile(bytes, 'book.zip')))
      .rejects.toThrow(/damaged or was not fully downloaded/);
  });
});

/** Insert zeros right before the central directory (salvage needed, offsets right) */
function gapBeforeCd(zip) {
  let eocd = zip.length - 22;
  while (u32(zip, eocd) !== 0x06054b50) eocd--;
  const cdOffset = u32(zip, eocd + 16);
  return new Uint8Array([...zip.subarray(0, cdOffset), ...new Uint8Array(4096), ...zip.subarray(cdOffset)]);
}

describe('extractImagesFromZip: recovery edge cases', () => {
  it('reports damage instead of "No image files found" when only non-images survive', async () => {
    const zip = await makeZip({ 'readme.txt': pseudoRandomBytes(100, 1), 'p1.jpg': pseudoRandomBytes(300, 2) });
    const bytes = zip.slice();
    bytes.fill(0, localOffsets(zip)['p1.jpg'], localOffsets(zip)['p1.jpg'] + 30);
    await expect(extractImagesFromZip(makeFile(bytes, 'book.zip')))
      .rejects.toThrow('book.zip is damaged and none of its images could be recovered (p1.jpg)');
  });

  it('does not report unsupported formats as damaged images', async () => {
    const zip = await makeZip({
      'p1.jpg': pseudoRandomBytes(300, 1),
      'p2.bmp': pseudoRandomBytes(300, 2),
      'p3.jpg': pseudoRandomBytes(300, 3)
    });
    const bytes = zip.slice();
    bytes.fill(0, localOffsets(zip)['p2.bmp'], localOffsets(zip)['p2.bmp'] + 30);
    const images = await extractImagesFromZip(makeFile(bytes, 'book.zip'));
    expect(images.map(i => i.filename)).toEqual(['p1.jpg', 'p3.jpg']);
    expect(images.recoveryWarning).toBe('book.zip was damaged and has been repaired.');
  });

  it('warns about entries lost with a damaged central directory record', async () => {
    const zip = await makeZip({
      'p1.jpg': pseudoRandomBytes(300, 1),
      'p2.jpg': pseudoRandomBytes(300, 2),
      'p3.jpg': pseudoRandomBytes(300, 3)
    });
    let eocd = zip.length - 22;
    while (u32(zip, eocd) !== 0x06054b50) eocd--;
    const cdOffset = u32(zip, eocd + 16);
    const secondRecord = cdOffset + 46 + u16(zip, cdOffset + 28) + u16(zip, cdOffset + 30);
    const damaged = zip.slice();
    damaged.fill(0, secondRecord, secondRecord + 46);
    const images = await extractImagesFromZip(makeFile(gapBeforeCd(damaged), 'book.zip'));
    expect(images.map(i => i.filename)).toEqual(['p1.jpg', 'p3.jpg']);
    expect(images.recoveryWarning).toBe('book.zip is damaged. 1 file(s) could not be found and may be missing');
  });
});

describe('batch notifications for damaged archives', () => {
  const notification = () => ({
    type: document.getElementById('notificationIcon').className,
    title: document.getElementById('notificationTitle').textContent,
    message: document.getElementById('notificationMessage').textContent
  });

  async function queue(files) {
    app.state.files.clear();
    for (const [name, bytes] of Object.entries(files)) {
      app.state.files.set(app.state.currentFileId++, { file: makeFile(bytes, name), type: 'zip', status: 'pending' });
    }
  }

  async function repairedAndBroken() {
    const good = await makeZip({ 'p1.jpg': pseudoRandomBytes(300, 1) });
    const broken = good.slice();
    broken.fill(0, 0, 30);
    return { 'repaired.zip': gapBeforeCd(good), 'broken.zip': broken };
  }

  it('individual mode shows recovery warnings and the reason a ZIP failed', async () => {
    await queue(await repairedAndBroken());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await app.convertAllZipsIndividually();
    error.mockRestore();
    const n = notification();
    expect(n.type).toContain('warning');
    expect(n.title).toBe('Batch Conversion Complete');
    expect(n.message).toContain('1 file(s) failed.');
    expect(n.message).toContain('repaired.zip was damaged and has been repaired.');
    expect(n.message).toContain('broken.zip: The ZIP file is damaged or was not fully downloaded');
  });

  it('individual mode names the failed ZIP when all conversions fail', async () => {
    const { 'broken.zip': broken } = await repairedAndBroken();
    await queue({ 'broken.zip': broken });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await app.convertAllZipsIndividually();
    error.mockRestore();
    const n = notification();
    expect(n.title).toBe('Conversion Failed');
    expect(n.message).toMatch(/^All conversions failed\.\n\nbroken\.zip: The ZIP file is damaged/);
  });

  it('merge mode shows a warning for a repaired ZIP', async () => {
    const { 'repaired.zip': repaired } = await repairedAndBroken();
    await queue({ 'a.zip': await makeZip({ 'p1.jpg': pseudoRandomBytes(300, 5) }), 'repaired.zip': repaired });
    await app.convertAllZipsToSinglePDF();
    const n = notification();
    expect(n.type).toContain('warning');
    expect(n.title).toBe('Merge Complete');
    expect(n.message).toContain('repaired.zip was damaged and has been repaired.');
  });

  it('merge mode names the ZIP that could not be recovered', async () => {
    const { 'broken.zip': broken } = await repairedAndBroken();
    await queue({ 'a.zip': await makeZip({ 'p1.jpg': pseudoRandomBytes(300, 5) }), 'broken.zip': broken });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await app.convertAllZipsToSinglePDF();
    error.mockRestore();
    const n = notification();
    expect(n.title).toBe('Error Occurred');
    expect(n.message).toMatch(/^broken\.zip: The ZIP file is damaged or was not fully downloaded/);
  });
});
