import { deflateSync } from 'node:zlib';

type Color = readonly [number, number, number];

export interface ImageTicketFacts {
  ticketId: string;
  stallPercentage: number;
  browser: string;
  owner: string;
  error: string;
}

const GLYPHS: Record<string, readonly string[]> = {
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '%': ['11001', '11010', '00100', '01000', '10110', '00110', '00000'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
};

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

/** A deterministic PNG whose ticket facts exist only as raster pixels. */
export function createImageTicketPng(facts: ImageTicketFacts): Buffer {
  const width = 960;
  const height = 600;
  const pixels = Buffer.alloc(width * height * 3);
  const fill = (x: number, y: number, w: number, h: number, color: Color): void => {
    for (let row = Math.max(0, y); row < Math.min(height, y + h); row += 1) {
      for (let column = Math.max(0, x); column < Math.min(width, x + w); column += 1) {
        const offset = (row * width + column) * 3;
        pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2];
      }
    }
  };
  const text = (value: string, x: number, y: number, scale: number, color: Color): void => {
    let cursor = x;
    for (const character of value) {
      const glyph = GLYPHS[character];
      if (!glyph) throw new Error(`missing image-ticket glyph '${character}'`);
      for (let row = 0; row < glyph.length; row += 1) {
        for (let column = 0; column < glyph[row]!.length; column += 1) {
          if (glyph[row]![column] === '1') fill(cursor + column * scale, y + row * scale, scale, scale, color);
        }
      }
      cursor += 6 * scale;
    }
  };

  fill(0, 0, width, height, [243, 244, 248]);
  fill(0, 0, width, 84, [76, 48, 158]);
  text('LINEAR', 42, 24, 5, [255, 255, 255]);
  fill(42, 116, 876, 438, [255, 255, 255]);
  fill(42, 116, 12, 438, [244, 114, 76]);
  text(`ISSUE ${facts.ticketId}`, 86, 150, 5, [69, 57, 89]);
  text(`UPLOAD STALLS AT ${facts.stallPercentage}%`, 86, 228, 5, [24, 28, 44]);
  fill(86, 312, 382, 86, [237, 233, 252]);
  fill(496, 312, 382, 86, [236, 246, 255]);
  text(`BROWSER ${facts.browser}`, 108, 340, 3, [76, 48, 158]);
  text(`OWNER ${facts.owner}`, 532, 340, 3, [32, 93, 133]);
  fill(86, 430, 792, 82, [255, 238, 232]);
  text(`ERROR ${facts.error}`, 120, 456, 4, [167, 54, 31]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  for (let row = 0; row < height; row += 1) {
    const target = row * (1 + width * 3);
    pixels.copy(scanlines, target + 1, row * width * 3, (row + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(scanlines, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
