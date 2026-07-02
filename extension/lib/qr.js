const VERSION = 3;
const SIZE = 21 + (VERSION - 1) * 4;
const DATA_CODEWORDS = 55;
const ECC_CODEWORDS = 15;
const QUIET_ZONE = 4;

export function createQrSvg(payload, options = {}) {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new Error('QR payload must be a non-empty string');
  }

  const bytes = new TextEncoder().encode(payload);
  if (bytes.length > 53) {
    throw new Error('QR payload is too long for raw address QR');
  }

  const modules = encodeQrBytes(bytes);
  const scale = options.scale || 5;
  const border = options.border ?? QUIET_ZONE;
  const viewSize = SIZE + border * 2;
  const path = modulesToPath(modules, border);
  const dim = viewSize * scale;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" width="${dim}" height="${dim}" role="img" aria-label="QR code">`,
    '<rect width="100%" height="100%" fill="#fff"/>',
    `<path fill="#050505" d="${path}"/>`,
    '</svg>',
  ].join('');
}

function encodeQrBytes(bytes) {
  const data = buildDataCodewords(bytes);
  const ecc = reedSolomonRemainder(data, ECC_CODEWORDS);
  const codewords = data.concat(ecc);

  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const matrix = buildFunctionMatrix();
    drawCodewords(matrix, codewords);
    applyMask(matrix, mask);
    drawFormatBits(matrix, mask);
    const penalty = scoreMatrix(matrix.modules);
    if (!best || penalty < best.penalty) best = { matrix: matrix.modules, penalty };
  }
  return best.matrix;
}

function buildDataCodewords(bytes) {
  const bits = [];
  appendBits(bits, 0b0100, 4); // Byte mode
  appendBits(bits, bytes.length, 8);
  for (const b of bytes) appendBits(bits, b, 8);

  const maxBits = DATA_CODEWORDS * 8;
  appendBits(bits, 0, Math.min(4, maxBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
    data.push(value);
  }

  for (let pad = 0xec; data.length < DATA_CODEWORDS; pad ^= 0xfd) {
    data.push(pad);
  }
  return data;
}

function appendBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
}

function buildFunctionMatrix() {
  const modules = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
  const reserved = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));

  const set = (x, y, dark = false) => {
    modules[y][x] = dark;
    reserved[y][x] = true;
  };

  drawFinder(set, 0, 0);
  drawFinder(set, SIZE - 7, 0);
  drawFinder(set, 0, SIZE - 7);
  drawTiming(set);
  drawAlignment(set, 22, 22);
  set(8, VERSION * 4 + 9, true);
  reserveFormat(set);

  return { modules, reserved };
}

function drawFinder(set, x, y) {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || xx >= SIZE || yy < 0 || yy >= SIZE) continue;
      const inCore = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const dark = inCore && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      set(xx, yy, dark);
    }
  }
}

function drawTiming(set) {
  for (let i = 8; i < SIZE - 8; i += 1) {
    const dark = i % 2 === 0;
    set(i, 6, dark);
    set(6, i, dark);
  }
}

function drawAlignment(set, cx, cy) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
      set(cx + dx, cy + dy, dark);
    }
  }
}

function reserveFormat(set) {
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      set(8, i, false);
      set(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    set(SIZE - 1 - i, 8, false);
    set(8, SIZE - 1 - i, false);
  }
}

function drawCodewords(matrix, codewords) {
  const bits = [];
  for (const codeword of codewords) appendBits(bits, codeword, 8);

  let bitIndex = 0;
  let upward = true;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let vert = 0; vert < SIZE; vert += 1) {
      const y = upward ? SIZE - 1 - vert : vert;
      for (let dx = 0; dx < 2; dx += 1) {
        const x = right - dx;
        if (matrix.reserved[y][x]) continue;
        matrix.modules[y][x] = bitIndex < bits.length ? bits[bitIndex] === 1 : false;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

function applyMask(matrix, mask) {
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (!matrix.reserved[y][x] && maskApplies(mask, x, y)) {
        matrix.modules[y][x] = !matrix.modules[y][x];
      }
    }
  }
}

function maskApplies(mask, x, y) {
  if (mask === 0) return (x + y) % 2 === 0;
  if (mask === 1) return y % 2 === 0;
  if (mask === 2) return x % 3 === 0;
  if (mask === 3) return (x + y) % 3 === 0;
  if (mask === 4) return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
  if (mask === 5) return ((x * y) % 2) + ((x * y) % 3) === 0;
  if (mask === 6) return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
  return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
}

function drawFormatBits(matrix, mask) {
  const bits = formatBits(mask);
  const set = (x, y, i) => {
    matrix.modules[y][x] = ((bits >>> i) & 1) !== 0;
  };

  for (let i = 0; i <= 5; i += 1) set(8, i, i);
  set(8, 7, 6);
  set(8, 8, 7);
  set(7, 8, 8);
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, i);

  for (let i = 0; i < 8; i += 1) set(SIZE - 1 - i, 8, i);
  for (let i = 8; i < 15; i += 1) set(8, SIZE - 15 + i, i);
  matrix.modules[SIZE - 8][8] = true;
}

function formatBits(mask) {
  const data = (0b01 << 3) | mask; // Error correction level L.
  let rem = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if (((rem >>> i) & 1) !== 0) rem ^= 0x537 << (i - 10);
  }
  return (((data << 10) | (rem & 0x3ff)) ^ 0x5412) & 0x7fff;
}

function reedSolomonRemainder(data, degree) {
  const generator = reedSolomonGenerator(degree);
  const result = Array(degree).fill(0);
  for (const value of data) {
    const factor = value ^ result.shift();
    result.push(0);
    for (let i = 0; i < degree; i += 1) {
      result[i] ^= gfMultiply(generator[i], factor);
    }
  }
  return result;
}

function reedSolomonGenerator(degree) {
  let result = [1];
  for (let i = 0; i < degree; i += 1) {
    const root = gfPow(2, i);
    const next = Array(result.length + 1).fill(0);
    for (let j = 0; j < result.length; j += 1) {
      next[j] ^= result[j];
      next[j + 1] ^= gfMultiply(result[j], root);
    }
    result = next;
  }
  return result.slice(1);
}

function gfPow(value, power) {
  let result = 1;
  for (let i = 0; i < power; i += 1) result = gfMultiply(result, value);
  return result;
}

function gfMultiply(a, b) {
  let result = 0;
  for (let i = 0; i < 8; i += 1) {
    if ((b & 1) !== 0) result ^= a;
    const carry = (a & 0x80) !== 0;
    a = (a << 1) & 0xff;
    if (carry) a ^= 0x1d;
    b >>>= 1;
  }
  return result;
}

function scoreMatrix(modules) {
  return scoreRuns(modules) + scoreBlocks(modules) + scoreFinderLike(modules) + scoreBalance(modules);
}

function scoreRuns(modules) {
  let penalty = 0;
  for (let y = 0; y < SIZE; y += 1) penalty += scoreLine(modules[y]);
  for (let x = 0; x < SIZE; x += 1) penalty += scoreLine(modules.map((row) => row[x]));
  return penalty;
}

function scoreLine(line) {
  let penalty = 0;
  let runColor = line[0];
  let runLength = 1;
  for (let i = 1; i < line.length; i += 1) {
    if (line[i] === runColor) {
      runLength += 1;
    } else {
      if (runLength >= 5) penalty += 3 + (runLength - 5);
      runColor = line[i];
      runLength = 1;
    }
  }
  if (runLength >= 5) penalty += 3 + (runLength - 5);
  return penalty;
}

function scoreBlocks(modules) {
  let penalty = 0;
  for (let y = 0; y < SIZE - 1; y += 1) {
    for (let x = 0; x < SIZE - 1; x += 1) {
      const color = modules[y][x];
      if (modules[y][x + 1] === color && modules[y + 1][x] === color && modules[y + 1][x + 1] === color) {
        penalty += 3;
      }
    }
  }
  return penalty;
}

function scoreFinderLike(modules) {
  let penalty = 0;
  const patterns = ['10111010000', '00001011101'];
  for (let y = 0; y < SIZE; y += 1) {
    const row = modules[y].map((v) => (v ? '1' : '0')).join('');
    for (const p of patterns) penalty += countPattern(row, p) * 40;
  }
  for (let x = 0; x < SIZE; x += 1) {
    const col = modules.map((row) => (row[x] ? '1' : '0')).join('');
    for (const p of patterns) penalty += countPattern(col, p) * 40;
  }
  return penalty;
}

function countPattern(line, pattern) {
  let count = 0;
  for (let i = 0; i <= line.length - pattern.length; i += 1) {
    if (line.slice(i, i + pattern.length) === pattern) count += 1;
  }
  return count;
}

function scoreBalance(modules) {
  const total = SIZE * SIZE;
  const dark = modules.flat().filter(Boolean).length;
  return Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
}

function modulesToPath(modules, border) {
  const parts = [];
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (modules[y][x]) parts.push(`M${x + border},${y + border}h1v1h-1z`);
    }
  }
  return parts.join('');
}
