import { open } from 'node:fs/promises'

export type BinaryFormat = 'pe' | 'elf' | 'macho' | 'script' | 'unknown'
export type BinaryArch = 'x64' | 'arm64' | 'ia32' | 'arm'

export interface BinaryInfo {
  format: BinaryFormat
  /** CPU architectures contained in the file. Universal Mach-O binaries list several. */
  archs: BinaryArch[]
}

const HEADER_BYTES = 4096

const PE_MACHINES: Record<number, BinaryArch> = { 0x8664: 'x64', 0xaa64: 'arm64', 0x014c: 'ia32', 0x01c4: 'arm' }
const ELF_MACHINES: Record<number, BinaryArch> = { 0x3e: 'x64', 0xb7: 'arm64', 0x03: 'ia32', 0x28: 'arm' }
const MACHO_CPUS: Record<number, BinaryArch> = { 0x01000007: 'x64', 0x0100000c: 'arm64', 0x07: 'ia32', 0x0c: 'arm' }

export async function inspectBinary(path: string): Promise<BinaryInfo> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0)
    return parseBinaryHeader(buffer.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

/** Identifies the executable format and CPU architecture(s) from a file's first bytes. */
export function parseBinaryHeader(header: Buffer): BinaryInfo {
  if (header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a) return parsePe(header)
  if (header.length >= 20 && header.readUInt32BE(0) === 0x7f454c46) return parseElf(header)
  if (header.length >= 8) {
    const magicBE = header.readUInt32BE(0)
    if (magicBE === 0xcafebabe || magicBE === 0xcafebabf) return parseFatMachO(header, magicBE === 0xcafebabf)
    const magicLE = header.readUInt32LE(0)
    if (magicLE === 0xfeedfacf || magicLE === 0xfeedface) return machO([header.readInt32LE(4)])
  }
  if (header.length >= 2 && header[0] === 0x23 && header[1] === 0x21) return { format: 'script', archs: [] }
  return { format: 'unknown', archs: [] }
}

function parsePe(header: Buffer): BinaryInfo {
  if (header.length < 0x40) return { format: 'unknown', archs: [] }
  const peOffset = header.readUInt32LE(0x3c)
  if (peOffset + 6 > header.length || header.readUInt32BE(peOffset) !== 0x50450000) {
    return { format: 'unknown', archs: [] }
  }
  const arch = PE_MACHINES[header.readUInt16LE(peOffset + 4)]
  return { format: 'pe', archs: arch ? [arch] : [] }
}

function parseElf(header: Buffer): BinaryInfo {
  const littleEndian = header[5] === 1
  const machine = littleEndian ? header.readUInt16LE(18) : header.readUInt16BE(18)
  const arch = ELF_MACHINES[machine]
  return { format: 'elf', archs: arch ? [arch] : [] }
}

function parseFatMachO(header: Buffer, is64: boolean): BinaryInfo {
  const count = header.readUInt32BE(4)
  const entrySize = is64 ? 32 : 20
  const cpus: number[] = []
  for (let i = 0; i < count && 8 + (i + 1) * entrySize <= header.length; i++) {
    cpus.push(header.readInt32BE(8 + i * entrySize))
  }
  return machO(cpus)
}

function machO(cpuTypes: number[]): BinaryInfo {
  const archs = cpuTypes.map((cpu) => MACHO_CPUS[cpu]).filter((arch): arch is BinaryArch => arch !== undefined)
  return { format: 'macho', archs: [...new Set(archs)] }
}

const EXPECTED_FORMAT: Partial<Record<NodeJS.Platform, BinaryFormat>> = {
  win32: 'pe',
  darwin: 'macho',
  linux: 'elf'
}

/** Architectures the OS can run natively or through its built-in emulation layer. */
const RUNNABLE_ARCHS: Record<string, BinaryArch[]> = {
  'win32-x64': ['x64', 'ia32'],
  'win32-arm64': ['arm64', 'x64', 'ia32'],
  'darwin-x64': ['x64'],
  'darwin-arm64': ['arm64', 'x64'],
  'linux-x64': ['x64'],
  'linux-arm64': ['arm64']
}

/** Returns a reason the binary cannot run on this platform, or null if it can. */
export function incompatibilityReason(info: BinaryInfo, platform: NodeJS.Platform, arch: string): string | null {
  const expected = EXPECTED_FORMAT[platform]
  if (!expected) return `Unsupported platform ${platform}`
  if (info.format !== expected) {
    return info.format === 'unknown' ? 'The file is not a recognised executable.' : `The file is a ${describe(info.format)}, not a ${describe(expected)}.`
  }
  const runnable = RUNNABLE_ARCHS[`${platform}-${arch}`] ?? [arch]
  if (!info.archs.some((candidate) => runnable.includes(candidate))) {
    const found = info.archs.length > 0 ? info.archs.join(', ') : 'an unknown architecture'
    return `The executable is built for ${found}, which cannot run on ${arch}.`
  }
  return null
}

function describe(format: BinaryFormat): string {
  switch (format) {
    case 'pe':
      return 'Windows executable'
    case 'elf':
      return 'Linux executable'
    case 'macho':
      return 'macOS executable'
    case 'script':
      return 'script'
    case 'unknown':
      return 'unrecognised file'
  }
}
