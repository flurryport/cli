const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function guidToBase62(guid: string): string {
  const hex = guid.replace(/-/g, '');
  if (hex.length !== 32) throw new Error(`Invalid GUID: ${guid}`);

  const bytes = new Uint8Array(16);

  bytes[0] = parseInt(hex.substring(6, 8), 16);
  bytes[1] = parseInt(hex.substring(4, 6), 16);
  bytes[2] = parseInt(hex.substring(2, 4), 16);
  bytes[3] = parseInt(hex.substring(0, 2), 16);
  bytes[4] = parseInt(hex.substring(10, 12), 16);
  bytes[5] = parseInt(hex.substring(8, 10), 16);
  bytes[6] = parseInt(hex.substring(14, 16), 16);
  bytes[7] = parseInt(hex.substring(12, 14), 16);

  for (let i = 0; i < 8; i++) {
    bytes[8 + i] = parseInt(hex.substring(16 + i * 2, 18 + i * 2), 16);
  }

  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    value = (value << 8n) | BigInt(bytes[i]);
  }

  if (value === 0n) return '0';

  const chars: string[] = [];
  while (value > 0n) {
    const remainder = Number(value % 62n);
    chars.unshift(ALPHABET[remainder]);
    value = value / 62n;
  }

  return chars.join('');
}

/**
 * Inverse of guidToBase62 — mirrors C# Base62Extensions.GuidFromBase62.
 * The BigInt decodes to the .NET Guid.ToByteArray() little-endian layout;
 * the first three groups are byte-swapped back into canonical hex order.
 */
export function base62ToGuid(base62: string): string {
  let value = 0n;
  for (const c of base62) {
    const digit = ALPHABET.indexOf(c);
    if (digit < 0) throw new Error(`Invalid Base62 character: '${c}'`);
    value = value * 62n + BigInt(digit);
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  if (value > 0n) throw new Error(`Base62 value overflows a GUID: ${base62}`);

  const hx = (b: number) => b.toString(16).padStart(2, '0');
  return (
    hx(bytes[3]) + hx(bytes[2]) + hx(bytes[1]) + hx(bytes[0]) +
    '-' + hx(bytes[5]) + hx(bytes[4]) +
    '-' + hx(bytes[7]) + hx(bytes[6]) +
    '-' + hx(bytes[8]) + hx(bytes[9]) +
    '-' + Array.from(bytes.slice(10)).map(hx).join('')
  );
}
