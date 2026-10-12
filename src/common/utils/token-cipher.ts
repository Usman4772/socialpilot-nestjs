import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

function decodeKey(raw: string): Buffer {
  const value = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return Buffer.from(value, 'hex');
  }
  const asBase64 = Buffer.from(value, 'base64');
  if (asBase64.length === 32) {
    return asBase64;
  }
  return createHash('sha256').update(value).digest();
}

/** AES-256-GCM. The stored value is `iv.tag.ciphertext`, all base64url. */
export function encryptSecret(plain: string, keyMaterial: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', decodeKey(keyMaterial), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString('base64url')).join('.');
}

export function decryptSecret(payload: string, keyMaterial: string): string {
  const [ivPart, tagPart, dataPart] = payload.split('.');
  if (!ivPart || !tagPart || !dataPart) {
    throw new Error('Encrypted value is malformed');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    decodeKey(keyMaterial),
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}
