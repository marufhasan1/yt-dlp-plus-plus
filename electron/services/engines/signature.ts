import { createMessage, readKey, readSignature, verify } from 'openpgp'
import { AppError } from '../../utils/errors'

/**
 * Verifies a detached OpenPGP signature (binary or ASCII-armored) over `data`
 * with a pinned public key. Throws INTEGRITY on any failure.
 */
export async function verifyDetachedSignature(
  data: Uint8Array,
  signatureBytes: Uint8Array,
  armoredKey: string,
  expectedFingerprint: string
): Promise<void> {
  const key = await readKey({ armoredKey })
  if (key.getFingerprint().toUpperCase() !== expectedFingerprint.toUpperCase()) {
    throw new AppError('INTEGRITY', 'The embedded signing key does not match its pinned fingerprint.')
  }

  try {
    const signature = await readSignatureAnyEncoding(signatureBytes)
    const message = await createMessage({ binary: data })
    const result = await verify({ message, signature, verificationKeys: key })
    const [first] = result.signatures
    if (!first) throw new Error('No signatures found')
    await first.verified
  } catch (error) {
    throw new AppError('INTEGRITY', 'The release signature could not be verified. The download was rejected.', {
      cause: error
    })
  }
}

async function readSignatureAnyEncoding(bytes: Uint8Array) {
  const text = Buffer.from(bytes).toString('utf8')
  if (text.includes('-----BEGIN PGP SIGNATURE-----')) {
    return readSignature({ armoredSignature: text })
  }
  return readSignature({ binarySignature: bytes })
}
