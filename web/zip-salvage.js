/**
 * ZIP salvage for zipped-imgs-to-pdf (web version).
 *
 * JSZip rejects a whole archive when the local header of any entry cannot be
 * found at the offset it expects ("Corrupted zip or bug: unexpected signature").
 * This happens with bytes inserted before the central directory, ZIP64 records
 * without markers, wrong per-entry offsets, or zero-filled regions from an
 * incomplete download.
 *
 * salvageZip() walks the central directory, finds each entry's local header
 * (by offset or by name), and rebuilds a clean archive from the entries it can
 * find. loadZipWithRecovery() tries JSZip first and uses the salvage only when
 * JSZip reports a corrupted archive.
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;
const MAX_U32 = 0xFFFFFFFF;
const EOCD_SIZE = 22;
const ZIP64_EOCD_AND_LOCATOR_SIZE = 76;
const MAX_ENTRIES = 0xFFFF; // the rebuilt archive has no ZIP64 records
const NAME_PREFIX_LENGTH = 16;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const SUPPORTED_METHODS = [0, 8]; // stored, deflate (what JSZip can read)

const CORRUPTION_ERROR_PATTERN = /Corrupted zip|End of data reached|unexpected signature|central dir/i;
const DAMAGED_ZIP_MESSAGE =
    'The ZIP file is damaged or was not fully downloaded, and no files could be recovered. ' +
    'Please download it again or re-create the ZIP file.';

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

/**
 * Compute the CRC-32 (IEEE) of the given bytes
 *
 * @param {Uint8Array} bytes - Data to checksum
 * @returns {number} Unsigned 32-bit CRC
 */
function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
        crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function readU16(d, o) {
    return d[o] | (d[o + 1] << 8);
}

function readU32(d, o) {
    return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
}

function readU64(d, o) {
    return readU32(d, o) + readU32(d, o + 4) * 0x100000000;
}

function writeU16(d, o, v) {
    d[o] = v & 0xFF;
    d[o + 1] = (v >>> 8) & 0xFF;
}

function writeU32(d, o, v) {
    d[o] = v & 0xFF;
    d[o + 1] = (v >>> 8) & 0xFF;
    d[o + 2] = (v >>> 16) & 0xFF;
    d[o + 3] = (v >>> 24) & 0xFF;
}

function hasSignature(d, o, sig) {
    return Number.isInteger(o) && o >= 0 && o + 4 <= d.length && readU32(d, o) === sig;
}

function bytesToKey(d, start, length) {
    let key = '';
    for (let i = 0; i < length; i++) {
        key += String.fromCharCode(d[start + i]);
    }
    return key;
}

function decodeName(nameBytes) {
    return new TextDecoder('utf-8').decode(nameBytes);
}

/**
 * Parse extra fields into [{id, data}] (stops at the first malformed field)
 */
function parseExtraFields(extra) {
    const fields = [];
    let p = 0;
    while (p + 4 <= extra.length) {
        const id = readU16(extra, p);
        const size = readU16(extra, p + 2);
        if (p + 4 + size > extra.length) break;
        fields.push({ id, data: extra.subarray(p + 4, p + 4 + size) });
        p += 4 + size;
    }
    return fields;
}

/**
 * Rebuild an extra field block without the ZIP64 field (sizes are rewritten as 32-bit)
 */
function stripZip64Extra(extra) {
    const kept = parseExtraFields(extra).filter(f => f.id !== ZIP64_EXTRA_ID);
    const out = new Uint8Array(kept.reduce((sum, f) => sum + 4 + f.data.length, 0));
    let p = 0;
    for (const f of kept) {
        writeU16(out, p, f.id);
        writeU16(out, p + 2, f.data.length);
        out.set(f.data, p + 4);
        p += 4 + f.data.length;
    }
    return out;
}

/**
 * Resolve 0xFFFFFFFF central directory values from the ZIP64 extra field
 * @returns {{uncompressedSize, compressedSize, localHeaderOffset}|null} null if unresolvable
 */
function resolveZip64Values(values, extra) {
    const needed = ['uncompressedSize', 'compressedSize', 'localHeaderOffset']
        .filter(key => values[key] === MAX_U32);
    if (needed.length === 0) return values;

    const zip64 = parseExtraFields(extra).find(f => f.id === ZIP64_EXTRA_ID);
    if (!zip64 || zip64.data.length < needed.length * 8) return null;

    const resolved = { ...values };
    needed.forEach((key, i) => {
        resolved[key] = readU64(zip64.data, i * 8);
    });
    return resolved;
}

/**
 * Find the End Of Central Directory record and the central directory it describes.
 * Searches the whole buffer backwards (like JSZip), so long trailing data is allowed.
 * @returns {{cdStart, cdEnd, cdOffset, entryCount}|null}
 */
function locateCentralDirectory(d) {
    for (let e = d.length - EOCD_SIZE; e >= 0; e--) {
        if (!hasSignature(d, e, SIG_EOCD)) continue;

        let entryCount = readU16(d, e + 10);
        let cdSize = readU32(d, e + 12);
        let cdOffset = readU32(d, e + 16);
        let cdEnd = e;

        const usesZip64 = entryCount === 0xFFFF || cdSize === MAX_U32 || cdOffset === MAX_U32;
        if (usesZip64 && hasSignature(d, e - 20, SIG_ZIP64_LOCATOR)) {
            const recordPos = [readU64(d, e - 20 + 8), e - ZIP64_EOCD_AND_LOCATOR_SIZE]
                .find(o => hasSignature(d, o, SIG_ZIP64_EOCD));
            if (recordPos !== undefined) {
                entryCount = readU64(d, recordPos + 32);
                cdSize = readU64(d, recordPos + 40);
                cdOffset = readU64(d, recordPos + 48);
                cdEnd = recordPos;
            }
        }

        const cdStart = [cdOffset, cdEnd - cdSize, e - ZIP64_EOCD_AND_LOCATOR_SIZE - cdSize]
            .find(o => hasSignature(d, o, SIG_CENTRAL));
        if (cdStart !== undefined) {
            return { cdStart, cdEnd, cdOffset, entryCount };
        }
    }
    return null;
}

function findSignature(d, from, end, sig) {
    for (let i = from; i + 4 <= end; i++) {
        if (readU32(d, i) === sig) return i;
    }
    return -1;
}

/**
 * Read central directory records in [cdStart, cdEnd) (bounds-checked).
 * A damaged record is passed over by searching for the next record signature.
 * Reads at most MAX_ENTRIES + 1 records.
 */
function readCentralDirectory(d, cdStart, cdEnd) {
    const records = [];
    let p = cdStart;
    while (p + 46 <= cdEnd && records.length <= MAX_ENTRIES) {
        if (!hasSignature(d, p, SIG_CENTRAL)) {
            p = findSignature(d, p + 1, cdEnd, SIG_CENTRAL);
            if (p < 0) break;
            continue;
        }
        const nameLength = readU16(d, p + 28);
        const extraLength = readU16(d, p + 30);
        const commentLength = readU16(d, p + 32);
        const end = p + 46 + nameLength + extraLength + commentLength;
        if (end > cdEnd) break;

        const nameStart = p + 46;
        records.push({
            header: d.subarray(p, p + 46),
            nameBytes: d.subarray(nameStart, nameStart + nameLength),
            nameKey: bytesToKey(d, nameStart, nameLength),
            extra: d.subarray(nameStart + nameLength, nameStart + nameLength + extraLength),
            comment: d.subarray(nameStart + nameLength + extraLength, end),
            flags: readU16(d, p + 8),
            method: readU16(d, p + 10),
            crc32: readU32(d, p + 16),
            compressedSize: readU32(d, p + 20),
            uncompressedSize: readU32(d, p + 24),
            localHeaderOffset: readU32(d, p + 42)
        });
        p = end;
    }
    return records;
}

/** Cheap key (name length + first bytes) used to ignore headers no CD record wants */
function namePrefixKey(d, start, length) {
    return `${length}:${bytesToKey(d, start, Math.min(length, NAME_PREFIX_LENGTH))}`;
}

/**
 * Build a name -> [offsets] index of the local file headers whose names the
 * central directory needs, in ONE forward pass. After a wanted header the scan
 * continues after its name, so every byte is read a bounded number of times.
 */
function indexLocalHeaders(d, records) {
    const wanted = new Set(records.map(r => namePrefixKey(r.nameBytes, 0, r.nameBytes.length)));
    const index = new Map();
    for (let i = 0; i + 30 <= d.length; i++) {
        if (d[i] !== 0x50 || d[i + 1] !== 0x4B || d[i + 2] !== 0x03 || d[i + 3] !== 0x04) continue;
        const nameStart = i + 30;
        const nameLength = readU16(d, i + 26);
        if (nameStart + nameLength > d.length || !wanted.has(namePrefixKey(d, nameStart, nameLength))) {
            continue;
        }
        const key = bytesToKey(d, nameStart, nameLength);
        const list = index.get(key);
        if (list) {
            list.push(i);
        } else {
            index.set(key, [i]);
        }
        i = nameStart + nameLength - 1;
    }
    return index;
}

function localHeaderMatches(d, offset, record) {
    if (!hasSignature(d, offset, SIG_LOCAL) || offset + 30 > d.length) return false;
    const nameLength = record.nameBytes.length;
    if (readU16(d, offset + 26) !== nameLength || offset + 30 + nameLength > d.length) return false;
    return bytesToKey(d, offset + 30, nameLength) === record.nameKey;
}

/**
 * Find the local header for a record: lho + extraBytes, lho, then the name index
 */
function findLocalHeader(d, record, extraBytes, used, lookupByName) {
    const lho = record.localHeaderOffset;
    const direct = [lho + extraBytes, lho]
        .find(o => !used.has(o) && localHeaderMatches(d, o, record));
    return direct !== undefined ? direct : lookupByName(record.nameKey);
}

/**
 * Turn a central directory record into a recoverable entry, or null
 */
function recoverEntry(d, record, extraBytes, used, lookupByName) {
    if (!SUPPORTED_METHODS.includes(record.method)) return null;

    const values = resolveZip64Values({
        uncompressedSize: record.uncompressedSize,
        compressedSize: record.compressedSize,
        localHeaderOffset: record.localHeaderOffset
    }, record.extra);
    if (!values || values.uncompressedSize >= MAX_U32 || values.compressedSize >= MAX_U32) {
        return null;
    }

    const resolvedRecord = { ...record, ...values };
    const offset = findLocalHeader(d, resolvedRecord, extraBytes, used, lookupByName);
    if (offset === undefined) return null;

    const nameLength = readU16(d, offset + 26);
    const localExtraLength = readU16(d, offset + 28);
    const dataStart = offset + 30 + nameLength + localExtraLength;
    const dataEnd = dataStart + values.compressedSize;
    if (dataEnd > d.length) return null;

    return {
        record: resolvedRecord,
        offset,
        dataEnd,
        localHeader: d.subarray(offset, offset + 30),
        localExtra: stripZip64Extra(d.subarray(offset + 30 + nameLength, dataStart)),
        centralExtra: stripZip64Extra(record.extra),
        data: d.subarray(dataStart, dataEnd)
    };
}

/**
 * Write a clean archive: local headers + data, central directory, EOCD
 */
function buildArchive(found) {
    const localSizes = found.map(f => 30 + f.record.nameBytes.length + f.localExtra.length + f.data.length);
    const centralSizes = found.map(f =>
        46 + f.record.nameBytes.length + f.centralExtra.length + f.record.comment.length);
    const localTotal = localSizes.reduce((a, b) => a + b, 0);
    const centralTotal = centralSizes.reduce((a, b) => a + b, 0);
    const out = new Uint8Array(localTotal + centralTotal + EOCD_SIZE);

    let p = 0;
    const offsets = found.map((f, i) => {
        const start = p;
        const { record } = f;
        out.set(f.localHeader, p);
        writeU16(out, p + 6, record.flags & ~FLAG_DATA_DESCRIPTOR);
        writeU16(out, p + 8, record.method);
        writeU32(out, p + 14, record.crc32);
        writeU32(out, p + 18, record.compressedSize);
        writeU32(out, p + 22, record.uncompressedSize);
        writeU16(out, p + 26, record.nameBytes.length);
        writeU16(out, p + 28, f.localExtra.length);
        out.set(record.nameBytes, p + 30);
        out.set(f.localExtra, p + 30 + record.nameBytes.length);
        out.set(f.data, p + 30 + record.nameBytes.length + f.localExtra.length);
        p += localSizes[i];
        return start;
    });

    found.forEach((f, i) => {
        const { record } = f;
        out.set(record.header, p);
        writeU16(out, p + 8, record.flags & ~FLAG_DATA_DESCRIPTOR);
        writeU32(out, p + 20, record.compressedSize);
        writeU32(out, p + 24, record.uncompressedSize);
        writeU16(out, p + 30, f.centralExtra.length);
        writeU16(out, p + 34, 0); // disk number start
        writeU32(out, p + 42, offsets[i]);
        out.set(record.nameBytes, p + 46);
        out.set(f.centralExtra, p + 46 + record.nameBytes.length);
        out.set(record.comment, p + 46 + record.nameBytes.length + f.centralExtra.length);
        p += centralSizes[i];
    });

    writeU32(out, p, SIG_EOCD);
    writeU16(out, p + 8, found.length);
    writeU16(out, p + 10, found.length);
    writeU32(out, p + 12, centralTotal);
    writeU32(out, p + 16, localTotal);
    return out;
}

/**
 * Entries whose data overlaps an entry that starts earlier. Real archives never
 * overlap; rejecting overlaps keeps the rebuilt archive no larger than the input.
 */
function findOverlapping(found) {
    const overlapping = new Set();
    let end = 0;
    [...found].sort((a, b) => a.offset - b.offset).forEach(f => {
        if (f.offset < end) {
            overlapping.add(f);
        } else {
            end = f.dataEnd;
        }
    });
    return overlapping;
}

/**
 * Salvage the readable entries of a damaged ZIP archive
 *
 * @param {Uint8Array} bytes - Raw ZIP bytes
 * @returns {{zipBytes: Uint8Array|null, entries: Array<{name, crc32, uncompressedSize}>,
 *            skipped: string[], lostCount: number}} lostCount: CD records that could not be read
 * @throws {Error} If the central directory has more than 65535 entries
 */
function salvageZip(bytes) {
    const d = bytes;
    const located = locateCentralDirectory(d);
    if (!located) {
        return { zipBytes: null, entries: [], skipped: [], lostCount: 0 };
    }

    const records = readCentralDirectory(d, located.cdStart, located.cdEnd);
    if (records.length > MAX_ENTRIES) {
        throw new Error(`ZIP file contains too many files (> ${MAX_ENTRIES})`);
    }
    const lostCount = Math.max(0, located.entryCount - records.length);
    const extraBytes = located.cdStart - located.cdOffset;
    const used = new Set();
    let index = null;
    const cursors = new Map();
    const lookupByName = key => {
        index = index || indexLocalHeaders(d, records);
        const candidates = index.get(key) || [];
        let c = cursors.get(key) || 0;
        while (c < candidates.length && used.has(candidates[c])) c++;
        cursors.set(key, c);
        return candidates[c];
    };

    const recovered = [];
    const skipped = [];
    const isDir = record => decodeName(record.nameBytes).endsWith('/');
    for (const record of records) {
        const entry = recoverEntry(d, record, extraBytes, used, lookupByName);
        if (entry) {
            used.add(entry.offset);
            recovered.push(entry);
        } else if (!isDir(record)) {
            skipped.push(decodeName(record.nameBytes));
        }
    }

    const overlapping = findOverlapping(recovered);
    const found = recovered.filter(f => !overlapping.has(f));
    overlapping.forEach(f => {
        if (!isDir(f.record)) skipped.push(decodeName(f.record.nameBytes));
    });

    const fileEntries = found.filter(f => !isDir(f.record));
    if (fileEntries.length === 0) {
        return { zipBytes: null, entries: [], skipped, lostCount };
    }

    return {
        zipBytes: buildArchive(found),
        entries: fileEntries.map(f => ({
            name: decodeName(f.record.nameBytes),
            crc32: f.record.crc32,
            uncompressedSize: f.record.uncompressedSize
        })),
        skipped,
        lostCount
    };
}

async function toUint8Array(file) {
    if (file instanceof Uint8Array) return file;
    if (file instanceof ArrayBuffer) return new Uint8Array(file);
    if (file && typeof file.arrayBuffer === 'function') {
        return new Uint8Array(await file.arrayBuffer());
    }
    return null;
}

function damagedZipError(cause) {
    const error = new Error(DAMAGED_ZIP_MESSAGE, { cause });
    error.cause = cause;
    return error;
}

/**
 * Load a ZIP with JSZip, salvaging it when JSZip reports a corrupted archive
 *
 * @param {Function} JSZipClass - The JSZip constructor
 * @param {File|Blob|ArrayBuffer|Uint8Array} file - ZIP data
 * @returns {Promise<{zip, recovered: boolean, skipped: string[], lostCount: number,
 *                    expectedCrc: Map<string, number>|null}>}
 * @throws {Error} Friendly error (with .cause) if nothing is recoverable; other errors unchanged
 */
async function loadZipWithRecovery(JSZipClass, file) {
    try {
        const zip = await new JSZipClass().loadAsync(file);
        return { zip, recovered: false, skipped: [], lostCount: 0, expectedCrc: null };
    } catch (error) {
        if (!CORRUPTION_ERROR_PATTERN.test(error?.message || '')) {
            throw error;
        }

        const bytes = await toUint8Array(file);
        if (!bytes) throw error;

        const { zipBytes, skipped, lostCount } = salvageZip(bytes);
        if (!zipBytes) throw damagedZipError(error);

        let zip;
        try {
            zip = await new JSZipClass().loadAsync(zipBytes);
        } catch (_) {
            throw damagedZipError(error);
        }

        const expectedCrc = new Map(
            Object.keys(zip.files)
                .filter(name => !zip.files[name].dir)
                .map(name => [name, zip.files[name]._data.crc32 >>> 0])
        );
        return { zip, recovered: true, skipped, lostCount, expectedCrc };
    }
}

/**
 * Read a file from a recovered ZIP and verify its CRC-32
 *
 * @param {JSZip} zip - Loaded (recovered) archive
 * @param {string} filename - Entry name
 * @param {Map<string, number>} expectedCrc - Expected CRC per entry name
 * @returns {Promise<Uint8Array|null>} The file data, or null if it is damaged
 */
async function readVerifiedFile(zip, filename, expectedCrc) {
    try {
        const bytes = await zip.file(filename).async('uint8array');
        if (crc32(bytes) !== expectedCrc.get(filename)) {
            console.warn(`Skipping damaged file (CRC mismatch): ${filename}`);
            return null;
        }
        return bytes;
    } catch (error) {
        console.warn(`Skipping damaged file: ${filename}`, error);
        return null;
    }
}

/**
 * Format a list of file names for display, truncating long lists
 *
 * @param {string[]} names - File names
 * @param {number} maxShown - Maximum number of names to show
 * @returns {string} e.g. "a.jpg, b.jpg and 3 more"
 */
function formatSkippedNames(names, maxShown = 10) {
    const shown = names.slice(0, maxShown).join(', ');
    const rest = names.length - maxShown;
    return rest > 0 ? `${shown} and ${rest} more` : shown;
}

// Export for use in tests (browser uses globals)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        crc32,
        salvageZip,
        loadZipWithRecovery,
        readVerifiedFile,
        formatSkippedNames,
        DAMAGED_ZIP_MESSAGE
    };
}
