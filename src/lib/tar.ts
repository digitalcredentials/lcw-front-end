// A tar writer for the data export: plain ustar, which every extractor
// opens (macOS Finder, Windows, tar(1)). Nothing here depends on the
// browser or on Node, so the export can be built in either.

export interface TarFile {
  // The path inside the archive, with `/` separators and no leading slash
  name: string
  bytes: Uint8Array
}

const BLOCK = 512
const encoder = new TextEncoder()

function writeField(header: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value)
  if (bytes.length > length) {
    throw new Error(`The tar field at ${offset} cannot hold ${value}`)
  }
  header.set(bytes, offset)
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0'
}

// Splits a path longer than the 100-byte name field into ustar's prefix
// (up to 155 bytes) and name, at a `/`. Throws when no split fits.
function splitName(name: string): { prefix: string; name: string } {
  if (encoder.encode(name).length <= 100) {
    return { prefix: '', name }
  }
  const parts = name.split('/')
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join('/')
    const rest = parts.slice(i).join('/')
    if (encoder.encode(prefix).length <= 155 && encoder.encode(rest).length <= 100) {
      return { prefix, name: rest }
    }
  }
  throw new Error(`The path is too long for a tar entry: ${name}`)
}

function header({ name, size, type, mtime }: { name: string; size: number; type: '0' | '5'; mtime: number }): Uint8Array {
  const block = new Uint8Array(BLOCK)
  const split = splitName(name)
  writeField(block, 0, 100, split.name)
  writeField(block, 100, 8, octal(type === '5' ? 0o755 : 0o644, 8))
  writeField(block, 108, 8, octal(0, 8))
  writeField(block, 116, 8, octal(0, 8))
  writeField(block, 124, 12, octal(size, 12))
  writeField(block, 136, 12, octal(mtime, 12))
  block.fill(0x20, 148, 156) // checksum field counts as spaces while summing
  writeField(block, 156, 1, type)
  writeField(block, 257, 6, 'ustar\0')
  writeField(block, 263, 2, '00')
  writeField(block, 345, 155, split.prefix)
  let sum = 0
  for (const byte of block) {
    sum += byte
  }
  writeField(block, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ')
  return block
}

// Packs files (and the directories their paths imply, in order of first
// appearance) into one ustar archive. `mtime` is seconds since the epoch;
// every entry carries the same stamp.
export function packTar(files: TarFile[], { mtime = Math.floor(Date.now() / 1000) }: { mtime?: number } = {}): Uint8Array {
  const blocks: Uint8Array[] = []
  const directories = new Set<string>()
  for (const file of files) {
    const parts = file.name.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      if (!directories.has(dir)) {
        directories.add(dir)
        blocks.push(header({ name: `${dir}/`, size: 0, type: '5', mtime }))
      }
    }
    blocks.push(header({ name: file.name, size: file.bytes.length, type: '0', mtime }))
    blocks.push(file.bytes)
    const padding = (BLOCK - (file.bytes.length % BLOCK)) % BLOCK
    if (padding) {
      blocks.push(new Uint8Array(padding))
    }
  }
  blocks.push(new Uint8Array(BLOCK * 2))
  const total = blocks.reduce((n, b) => n + b.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const block of blocks) {
    out.set(block, offset)
    offset += block.length
  }
  return out
}
