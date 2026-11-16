/**
 * Builds the first bytes of an executable for a given platform/arch, enough for
 * electron/services/engines/binary-format.ts to identify it. Used to create
 * stand-in engine files without shipping real binaries in the test suite.
 */
const PE_MACHINE: Record<string, number> = { x64: 0x8664, arm64: 0xaa64, ia32: 0x014c }
const ELF_MACHINE: Record<string, number> = { x64: 0x3e, arm64: 0xb7, ia32: 0x03 }
const MACHO_CPU: Record<string, number> = { x64: 0x01000007, arm64: 0x0100000c }

export function peHeader(arch: string): Buffer {
  const buffer = Buffer.alloc(512)
  buffer.write('MZ', 0, 'ascii')
  buffer.writeUInt32LE(0x80, 0x3c)
  buffer.write('PE\0\0', 0x80, 'binary')
  buffer.writeUInt16LE(PE_MACHINE[arch] ?? 0, 0x84)
  return buffer
}

export function elfHeader(arch: string): Buffer {
  const buffer = Buffer.alloc(64)
  buffer.writeUInt32BE(0x7f454c46, 0)
  buffer[4] = 2 // 64-bit
  buffer[5] = 1 // little-endian
  buffer.writeUInt16LE(ELF_MACHINE[arch] ?? 0, 18)
  return buffer
}

export function machOHeader(arch: string): Buffer {
  const buffer = Buffer.alloc(32)
  buffer.writeUInt32LE(0xfeedfacf, 0)
  buffer.writeInt32LE(MACHO_CPU[arch] ?? 0, 4)
  return buffer
}

export function fatMachOHeader(archs: string[]): Buffer {
  const buffer = Buffer.alloc(8 + archs.length * 20)
  buffer.writeUInt32BE(0xcafebabe, 0)
  buffer.writeUInt32BE(archs.length, 4)
  archs.forEach((arch, i) => buffer.writeInt32BE(MACHO_CPU[arch] ?? 0, 8 + i * 20))
  return buffer
}

/** An executable header valid for the machine running the tests. */
export function nativeExecutable(platform: NodeJS.Platform = process.platform, arch: string = process.arch): Buffer {
  if (platform === 'win32') return peHeader(arch)
  if (platform === 'darwin') return machOHeader(arch)
  return elfHeader(arch)
}
