import { ProtocolFault } from '../../shared/faults.js';

export interface RasterInfo { readonly width: number; readonly height: number; readonly mime: 'image/png' | 'image/jpeg' | 'image/webp' }
export const MAX_BACKGROUND_BYTES = 24 * 1024 * 1024;
export const MAX_BACKGROUND_PIXELS = 32 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** 原生解码前验证尺寸；不接 SVG／GIF 或带动画的 WebP，不靠文件扩展名识别。 */
export function parseRasterInfo(bytes: Buffer): RasterInfo {
  if (bytes.length < 24 || bytes.length > MAX_BACKGROUND_BYTES) throw new ProtocolFault('budget');
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new ProtocolFault('protocol');
    let cursor = 8; let chunks = 0;
    while (cursor + 8 <= bytes.length) {
      if (++chunks > 4096) throw new ProtocolFault('budget');
      const kind = bytes.toString('ascii', cursor + 4, cursor + 8);
      if (kind === 'acTL' || kind === 'fcTL' || kind === 'fdAT') throw new ProtocolFault('unsupported');
      const length = bytes.readUInt32BE(cursor); if (cursor + length + 12 > bytes.length) break;
      cursor += length + 12;
    }
    return checked(bytes.readUInt32BE(16), bytes.readUInt32BE(20), 'image/png');
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegInfo(bytes);
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return webpInfo(bytes);
  throw new ProtocolFault('unsupported');
}
function checked(width: number, height: number, mime: RasterInfo['mime']): RasterInfo {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > MAX_BACKGROUND_PIXELS) throw new ProtocolFault('budget');
  return { width, height, mime };
}
function jpegInfo(bytes: Buffer): RasterInfo {
  let cursor = 2;
  while (cursor < bytes.length && cursor < 1024 * 1024) {
    if (bytes[cursor++] !== 0xff) throw new ProtocolFault('protocol');
    while (bytes[cursor] === 0xff) cursor++;
    const marker = bytes[cursor++]; if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0xd8 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (cursor + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(cursor); if (length < 2 || cursor + length > bytes.length) throw new ProtocolFault('protocol');
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) throw new ProtocolFault('protocol');
      return checked(bytes.readUInt16BE(cursor + 5), bytes.readUInt16BE(cursor + 3), 'image/jpeg');
    }
    cursor += length;
  }
  throw new ProtocolFault('protocol');
}
function webpInfo(bytes: Buffer): RasterInfo {
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw new ProtocolFault('protocol');
  let extended: RasterInfo | undefined; let raster: RasterInfo | undefined;
  for (let cursor = 12; cursor + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', cursor, cursor + 4); const length = bytes.readUInt32LE(cursor + 4); const start = cursor + 8;
    if (start + length > bytes.length) throw new ProtocolFault('protocol');
    if (kind === 'VP8X') {
      if (length !== 10 || ((bytes[start] ?? 0) & 2) !== 0) throw new ProtocolFault('unsupported');
      extended = checked(bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1, 'image/webp');
    } else if (kind === 'VP8 ') {
      if (length < 10 || bytes[start + 3] !== 0x9d || bytes[start + 4] !== 0x01 || bytes[start + 5] !== 0x2a) throw new ProtocolFault('protocol');
      raster = checked(bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff, 'image/webp');
    } else if (kind === 'VP8L') {
      if (length < 5 || bytes[start] !== 0x2f) throw new ProtocolFault('protocol');
      const bits = bytes.readUInt32LE(start + 1); raster = checked((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, 'image/webp');
    } else if (kind === 'ANIM' || kind === 'ANMF') throw new ProtocolFault('unsupported');
    cursor = start + length + (length % 2);
  }
  if (raster === undefined || extended !== undefined && (raster.width !== extended.width || raster.height !== extended.height)) throw new ProtocolFault('protocol');
  return raster;
}
