import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const SAFE_ARCHIVE_FILENAME_RE = /^[a-z0-9-]+-\d+\.\d+\.\d+\.zip$/;

export const ZIP_LIMITS = Object.freeze({
  maxEntries: 64,
  maxSingleFileBytes: 2 * 1024 * 1024,
  maxUncompressedTotalBytes: 5 * 1024 * 1024,
  maxCompressedZipBytes: 2 * 1024 * 1024,
  maxCompressionRatio: 100,
  ratioCheckMinBytes: 4096,
});

// Fixed DOS timestamp: 1980-01-01 00:00:00
export const FIXED_DOS_TIME = 0x0000;
export const FIXED_DOS_DATE = 0x0021;
// UNIX regular file (0100644) shifted into upper 16 bits of external attributes
export const FIXED_UNIX_FILE_ATTRIBUTES = (0o100644 << 16) >>> 0;
export const VERSION_MADE_BY_UNIX = 0x031e;
const VERSION_NEEDED = 20;
const FLAG_UTF8 = 0x0800;

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const FORBIDDEN_PATH_SEGMENTS = new Set(['.', '..', 'node_modules', 'dist-packages']);

export function validateArchiveFileName(fileName) {
  if (typeof fileName !== 'string' || fileName.length === 0) {
    throw new Error('Archive filename must be a non-empty string.');
  }
  if (fileName.includes('\0') || fileName.includes('/') || fileName.includes('\\')) {
    throw new Error(`Unsafe archive filename "${fileName}": path separators and null bytes are not allowed.`);
  }
  if (!SAFE_ARCHIVE_FILENAME_RE.test(fileName)) {
    throw new Error(
      `Unsafe archive filename "${fileName}": must match ${SAFE_ARCHIVE_FILENAME_RE.source}.`,
    );
  }
  return fileName;
}

export function validateArchiveEntryPath(entryPath) {
  if (typeof entryPath !== 'string' || entryPath.length === 0) {
    throw new Error('Archive entry path must be a non-empty string.');
  }
  if (entryPath.includes('\0')) {
    throw new Error(`Unsafe archive entry path "${entryPath}": null byte is not allowed.`);
  }
  if (entryPath.includes('\\')) {
    throw new Error(`Unsafe archive entry path "${entryPath}": backslashes are not allowed.`);
  }
  if (entryPath.startsWith('/')) {
    throw new Error(`Unsafe archive entry path "${entryPath}": leading slash is not allowed.`);
  }
  if (/^[A-Za-z]:/.test(entryPath)) {
    throw new Error(`Unsafe archive entry path "${entryPath}": drive letter prefixes are not allowed.`);
  }
  if (entryPath.endsWith('/')) {
    throw new Error(`Unsafe archive entry path "${entryPath}": directory entries or trailing slashes are not allowed.`);
  }

  const segments = entryPath.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new Error(`Unsafe archive entry path "${entryPath}": empty path segment.`);
    }
    if (FORBIDDEN_PATH_SEGMENTS.has(segment)) {
      throw new Error(`Unsafe archive entry path "${entryPath}": forbidden segment "${segment}".`);
    }
    if (segment.startsWith('.')) {
      throw new Error(`Unsafe archive entry path "${entryPath}": hidden dotfile/dotdir "${segment}" is not allowed.`);
    }
  }
  return entryPath;
}

function toBuffer(data, label = 'data') {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  throw new Error(`Expected ${label} to be a Buffer, Uint8Array, ArrayBuffer, or string.`);
}

export function comparePosixPaths(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildDeterministicZip(entries, options = {}) {
  if (!Array.isArray(entries)) {
    throw new Error('ZIP entries must be an array.');
  }
  if (options.fileName !== undefined) {
    validateArchiveFileName(options.fileName);
  }
  if (entries.length > ZIP_LIMITS.maxEntries) {
    throw new Error(`Archive exceeds max entry cap (${entries.length} > ${ZIP_LIMITS.maxEntries}).`);
  }

  const seenPaths = new Set();
  const prepared = [];
  let totalUncompressed = 0;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('Each archive entry must be an object { path, data }.');
    }
    if (entry.isSymlink === true) {
      throw new Error(`Refusing to package symlink entry "${entry.path}".`);
    }
    const normalizedPath = validateArchiveEntryPath(entry.path);
    if (seenPaths.has(normalizedPath)) {
      throw new Error(`Duplicate archive entry path "${normalizedPath}".`);
    }
    seenPaths.add(normalizedPath);

    const rawData = toBuffer(entry.data, `entry "${normalizedPath}" data`);
    if (rawData.byteLength > ZIP_LIMITS.maxSingleFileBytes) {
      throw new Error(
        `Entry "${normalizedPath}" exceeds single-file cap (${rawData.byteLength} > ${ZIP_LIMITS.maxSingleFileBytes} bytes).`,
      );
    }
    totalUncompressed += rawData.byteLength;
    if (totalUncompressed > ZIP_LIMITS.maxUncompressedTotalBytes) {
      throw new Error(
        `Archive exceeds total uncompressed cap (${totalUncompressed} > ${ZIP_LIMITS.maxUncompressedTotalBytes} bytes).`,
      );
    }

    const crc32 = zlib.crc32(rawData) >>> 0;
    const deflated = rawData.byteLength === 0 ? rawData : zlib.deflateRawSync(rawData, { level: 9 });
    const useStore = rawData.byteLength === 0 || deflated.byteLength >= rawData.byteLength;
    const method = useStore ? 0 : 8;
    const payload = useStore ? rawData : deflated;

    prepared.push({
      path: normalizedPath,
      nameBytes: Buffer.from(normalizedPath, 'utf8'),
      crc32,
      method,
      uncompressedSize: rawData.byteLength,
      compressedSize: payload.byteLength,
      payload,
    });
  }

  prepared.sort((a, b) => comparePosixPaths(a.path, b.path));

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const item of prepared) {
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0);
    localHeader.writeUInt16LE(VERSION_NEEDED, 4);
    localHeader.writeUInt16LE(FLAG_UTF8, 6);
    localHeader.writeUInt16LE(item.method, 8);
    localHeader.writeUInt16LE(FIXED_DOS_TIME, 10);
    localHeader.writeUInt16LE(FIXED_DOS_DATE, 12);
    localHeader.writeUInt32LE(item.crc32, 14);
    localHeader.writeUInt32LE(item.compressedSize, 18);
    localHeader.writeUInt32LE(item.uncompressedSize, 22);
    localHeader.writeUInt16LE(item.nameBytes.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_DIR_HEADER_SIG, 0);
    centralHeader.writeUInt16LE(VERSION_MADE_BY_UNIX, 4);
    centralHeader.writeUInt16LE(VERSION_NEEDED, 6);
    centralHeader.writeUInt16LE(FLAG_UTF8, 8);
    centralHeader.writeUInt16LE(item.method, 10);
    centralHeader.writeUInt16LE(FIXED_DOS_TIME, 12);
    centralHeader.writeUInt16LE(FIXED_DOS_DATE, 14);
    centralHeader.writeUInt32LE(item.crc32, 16);
    centralHeader.writeUInt32LE(item.compressedSize, 20);
    centralHeader.writeUInt32LE(item.uncompressedSize, 24);
    centralHeader.writeUInt16LE(item.nameBytes.byteLength, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(FIXED_UNIX_FILE_ATTRIBUTES, 38);
    centralHeader.writeUInt32LE(offset, 42);

    localChunks.push(localHeader, item.nameBytes, item.payload);
    centralChunks.push(centralHeader, item.nameBytes);
    offset += localHeader.byteLength + item.nameBytes.byteLength + item.payload.byteLength;
  }

  const cdBuffer = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(prepared.length, 8);
  eocd.writeUInt16LE(prepared.length, 10);
  eocd.writeUInt32LE(cdBuffer.byteLength, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const zipBuffer = Buffer.concat([...localChunks, cdBuffer, eocd]);
  if (zipBuffer.byteLength > ZIP_LIMITS.maxCompressedZipBytes) {
    throw new Error(
      `Compressed ZIP exceeds size cap (${zipBuffer.byteLength} > ${ZIP_LIMITS.maxCompressedZipBytes} bytes).`,
    );
  }
  return zipBuffer;
}

function findEocdOffset(buf) {
  const minOffset = Math.max(0, buf.byteLength - 22 - 0xffff);
  for (let i = buf.byteLength - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.byteLength) {
        return i;
      }
    }
  }
  throw new Error('Invalid ZIP archive: End of Central Directory record not found.');
}

export function parseDeterministicZip(zipInput, options = {}) {
  if (options.fileName !== undefined) {
    validateArchiveFileName(options.fileName);
  }
  const buf = toBuffer(zipInput, 'ZIP archive');
  if (buf.byteLength < 22) {
    throw new Error('Invalid ZIP archive: buffer too short.');
  }
  if (buf.byteLength > ZIP_LIMITS.maxCompressedZipBytes) {
    throw new Error(
      `ZIP archive exceeds compressed size cap (${buf.byteLength} > ${ZIP_LIMITS.maxCompressedZipBytes} bytes).`,
    );
  }

  const eocdOffset = findEocdOffset(buf);
  const diskNumber = buf.readUInt16LE(eocdOffset + 4);
  const cdDisk = buf.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buf.readUInt16LE(eocdOffset + 8);
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new Error('Multi-disk ZIP archives are not supported.');
  }
  if (totalEntries > ZIP_LIMITS.maxEntries) {
    throw new Error(`ZIP archive exceeds max entry cap (${totalEntries} > ${ZIP_LIMITS.maxEntries}).`);
  }
  if (cdOffset + cdSize !== eocdOffset) {
    throw new Error('Invalid ZIP archive: central directory bounds do not match EOCD.');
  }

  const strictDeterministic = options.strictDeterministic === true;
  const seenPaths = new Set();
  const parsedEntries = [];
  let declaredTotalUncompressed = 0;
  let actualTotalUncompressed = 0;
  let cursor = cdOffset;
  let prevPath = null;

  for (let i = 0; i < totalEntries; i++) {
    if (cursor + 46 > cdOffset + cdSize) {
      throw new Error('Invalid ZIP archive: truncated central directory entry.');
    }
    if (buf.readUInt32LE(cursor) !== CENTRAL_DIR_HEADER_SIG) {
      throw new Error('Invalid ZIP archive: bad central directory header signature.');
    }

    const versionMadeBy = buf.readUInt16LE(cursor + 4);
    const flags = buf.readUInt16LE(cursor + 8);
    const method = buf.readUInt16LE(cursor + 10);
    const dosTime = buf.readUInt16LE(cursor + 12);
    const dosDate = buf.readUInt16LE(cursor + 14);
    const expectedCrc32 = buf.readUInt32LE(cursor + 16);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const externalAttributes = buf.readUInt32LE(cursor + 38);
    const localOffset = buf.readUInt32LE(cursor + 42);

    const headerEnd = cursor + 46 + nameLen + extraLen + commentLen;
    if (headerEnd > cdOffset + cdSize) {
      throw new Error('Invalid ZIP archive: central directory entry extends past central directory.');
    }

    const entryPath = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    validateArchiveEntryPath(entryPath);
    if (seenPaths.has(entryPath)) {
      throw new Error(`Invalid ZIP archive: duplicate entry "${entryPath}".`);
    }
    seenPaths.add(entryPath);

    if (strictDeterministic && prevPath !== null && comparePosixPaths(prevPath, entryPath) >= 0) {
      throw new Error(`Non-deterministic ZIP entry ordering ("${prevPath}" before "${entryPath}").`);
    }
    prevPath = entryPath;

    if ((flags & 0x0001) !== 0) {
      throw new Error(`ZIP entry "${entryPath}" is encrypted, which is forbidden.`);
    }
    if ((flags & 0x0008) !== 0) {
      throw new Error(`ZIP entry "${entryPath}" uses streaming data descriptors, which are forbidden.`);
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`ZIP entry "${entryPath}" uses unsupported compression method ${method}.`);
    }

    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const unixFileType = unixMode & 0o170000;
    if (unixFileType === 0o120000) {
      throw new Error(`ZIP entry "${entryPath}" is a symlink, which is forbidden.`);
    }
    if ((versionMadeBy >> 8) === 3 && unixFileType !== 0 && unixFileType !== 0o100000) {
      throw new Error(`ZIP entry "${entryPath}" has non-regular UNIX file mode 0${unixFileType.toString(8)}.`);
    }

    if (strictDeterministic) {
      if (dosTime !== FIXED_DOS_TIME || dosDate !== FIXED_DOS_DATE) {
        throw new Error(`ZIP entry "${entryPath}" does not have fixed deterministic DOS timestamp.`);
      }
      if (externalAttributes !== FIXED_UNIX_FILE_ATTRIBUTES) {
        throw new Error(`ZIP entry "${entryPath}" does not have fixed UNIX 0644 attributes.`);
      }
    }

    if (uncompressedSize > ZIP_LIMITS.maxSingleFileBytes) {
      throw new Error(
        `ZIP entry "${entryPath}" exceeds single-file cap (${uncompressedSize} > ${ZIP_LIMITS.maxSingleFileBytes} bytes).`,
      );
    }
    declaredTotalUncompressed += uncompressedSize;
    if (declaredTotalUncompressed > ZIP_LIMITS.maxUncompressedTotalBytes) {
      throw new Error(
        `ZIP archive declared uncompressed size exceeds cap (${declaredTotalUncompressed} > ${ZIP_LIMITS.maxUncompressedTotalBytes} bytes).`,
      );
    }
    if (compressedSize === 0 && uncompressedSize > 0) {
      throw new Error(`ZIP entry "${entryPath}" has zero compressed size for non-empty payload.`);
    }
    if (
      uncompressedSize > ZIP_LIMITS.ratioCheckMinBytes
      && compressedSize > 0
      && uncompressedSize / compressedSize > ZIP_LIMITS.maxCompressionRatio
    ) {
      throw new Error(
        `ZIP entry "${entryPath}" exceeds max compression ratio (${Math.round(uncompressedSize / compressedSize)}:1 > ${ZIP_LIMITS.maxCompressionRatio}:1).`,
      );
    }

    if (localOffset + 30 > cdOffset) {
      throw new Error(`ZIP entry "${entryPath}" local header extends into central directory.`);
    }
    if (buf.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER_SIG) {
      throw new Error(`ZIP entry "${entryPath}" has invalid local file header signature.`);
    }
    const localMethod = buf.readUInt16LE(localOffset + 8);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > cdOffset) {
      throw new Error(`ZIP entry "${entryPath}" compressed data extends past local payload region.`);
    }
    const localName = buf.subarray(localOffset + 30, localOffset + 30 + localNameLen).toString('utf8');
    if (localName !== entryPath || localMethod !== method) {
      throw new Error(`ZIP entry "${entryPath}" local header mismatches central directory metadata.`);
    }

    const compressedSlice = buf.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) {
      if (compressedSize !== uncompressedSize) {
        throw new Error(`Stored ZIP entry "${entryPath}" size mismatch (${compressedSize} != ${uncompressedSize}).`);
      }
      data = Buffer.from(compressedSlice);
    } else {
      data = zlib.inflateRawSync(compressedSlice, { maxOutputLength: ZIP_LIMITS.maxSingleFileBytes });
    }

    if (data.byteLength !== uncompressedSize) {
      throw new Error(
        `ZIP entry "${entryPath}" inflated size mismatch (${data.byteLength} != ${uncompressedSize}).`,
      );
    }
    actualTotalUncompressed += data.byteLength;
    if (actualTotalUncompressed > ZIP_LIMITS.maxUncompressedTotalBytes) {
      throw new Error(
        `ZIP archive actual uncompressed size exceeds cap (${actualTotalUncompressed} > ${ZIP_LIMITS.maxUncompressedTotalBytes} bytes).`,
      );
    }
    const actualCrc = zlib.crc32(data) >>> 0;
    if (actualCrc !== expectedCrc32) {
      throw new Error(`ZIP entry "${entryPath}" CRC-32 mismatch.`);
    }

    parsedEntries.push({
      path: entryPath,
      data,
      sizeBytes: data.byteLength,
      compressedSize,
      crc32: actualCrc,
      method,
      dosTime,
      dosDate,
      externalAttributes,
    });

    cursor = headerEnd;
  }

  if (cursor !== cdOffset + cdSize) {
    throw new Error('Invalid ZIP archive: central directory size mismatch.');
  }

  return {
    fileCount: parsedEntries.length,
    totalUncompressedBytes: actualTotalUncompressed,
    compressedBytes: buf.byteLength,
    entries: parsedEntries,
  };
}

export function unpackDeterministicZip(zipInput, targetDir, options = {}) {
  const inspected = parseDeterministicZip(zipInput, options);
  fs.mkdirSync(targetDir, { recursive: true });
  const realTarget = fs.realpathSync(targetDir);

  for (const entry of inspected.entries) {
    const destPath = path.resolve(realTarget, entry.path);
    if (!destPath.startsWith(realTarget + path.sep)) {
      throw new Error(`Refusing to extract "${entry.path}" outside target directory.`);
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, entry.data);
  }

  return inspected;
}
