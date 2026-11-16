import { describe, expect, it } from 'vitest'
import { incompatibilityReason, inspectBinary, parseBinaryHeader } from '../../electron/services/engines/binary-format'
import { elfHeader, fatMachOHeader, machOHeader, peHeader } from '../helpers/fake-binary'

describe('parseBinaryHeader', () => {
  it.each([
    ['PE x64', peHeader('x64'), 'pe', ['x64']],
    ['PE arm64', peHeader('arm64'), 'pe', ['arm64']],
    ['PE ia32', peHeader('ia32'), 'pe', ['ia32']],
    ['ELF x64', elfHeader('x64'), 'elf', ['x64']],
    ['ELF arm64', elfHeader('arm64'), 'elf', ['arm64']],
    ['Mach-O arm64', machOHeader('arm64'), 'macho', ['arm64']],
    ['universal Mach-O', fatMachOHeader(['x64', 'arm64']), 'macho', ['x64', 'arm64']]
  ])('identifies %s', (_label, header, format, archs) => {
    expect(parseBinaryHeader(header)).toEqual({ format, archs })
  })

  it('recognises scripts and unknown data', () => {
    expect(parseBinaryHeader(Buffer.from('#!/usr/bin/env python3\n'))).toEqual({ format: 'script', archs: [] })
    expect(parseBinaryHeader(Buffer.from('<html>404 Not Found</html>'))).toEqual({ format: 'unknown', archs: [] })
    expect(parseBinaryHeader(Buffer.alloc(0))).toEqual({ format: 'unknown', archs: [] })
  })

  it('does not trust an MZ stub without a valid PE header', () => {
    const truncated = peHeader('x64').subarray(0, 0x60)
    expect(parseBinaryHeader(truncated).format).toBe('unknown')
  })

  it('reads the real Node.js executable', async () => {
    const info = await inspectBinary(process.execPath)
    expect(info.format).toBe({ win32: 'pe', darwin: 'macho', linux: 'elf' }[process.platform as 'win32'])
    expect(info.archs).toContain(process.arch)
  })
})

describe('incompatibilityReason', () => {
  it('accepts native binaries', () => {
    expect(incompatibilityReason({ format: 'pe', archs: ['x64'] }, 'win32', 'x64')).toBeNull()
    expect(incompatibilityReason({ format: 'elf', archs: ['arm64'] }, 'linux', 'arm64')).toBeNull()
    expect(incompatibilityReason({ format: 'macho', archs: ['x64', 'arm64'] }, 'darwin', 'arm64')).toBeNull()
  })

  it('accepts binaries the OS can emulate', () => {
    expect(incompatibilityReason({ format: 'pe', archs: ['x64'] }, 'win32', 'arm64')).toBeNull()
    expect(incompatibilityReason({ format: 'macho', archs: ['x64'] }, 'darwin', 'arm64')).toBeNull()
  })

  it('rejects the wrong format or architecture', () => {
    expect(incompatibilityReason({ format: 'elf', archs: ['x64'] }, 'win32', 'x64')).toMatch(/Linux executable/)
    expect(incompatibilityReason({ format: 'pe', archs: ['arm64'] }, 'win32', 'x64')).toMatch(/arm64/)
    expect(incompatibilityReason({ format: 'elf', archs: ['x64'] }, 'linux', 'arm64')).toMatch(/cannot run/)
    expect(incompatibilityReason({ format: 'macho', archs: ['arm64'] }, 'darwin', 'x64')).toMatch(/cannot run/)
    expect(incompatibilityReason({ format: 'unknown', archs: [] }, 'linux', 'x64')).toMatch(/not a recognised/)
  })
})
