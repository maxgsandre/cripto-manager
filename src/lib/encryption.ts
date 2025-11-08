const MASTER_KEY = process.env.ENCRYPTION_KEY || 'default-key-change-in-production-32chars!!!!';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sodiumLib = require('libsodium-wrappers-sumo');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sodium: any = null;

async function getSodium() {
  if (sodium) return sodium;
  // libsodium-wrappers-sumo exports the module directly, not with .default
  const lib = await new Promise((resolve) => {
    sodiumLib.ready.then(() => resolve(sodiumLib));
  });
  sodium = lib;
  return sodium;
}

export async function encrypt(data: string): Promise<string> {
  const s = await getSodium();
  
  // Derive key from master key
  const salt = s.randombytes_buf(s.crypto_pwhash_SALTBYTES);
  const key = s.crypto_pwhash(
    32, // key length
    MASTER_KEY,
    salt, // salt deve ter 16 bytes
    s.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    s.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    s.crypto_pwhash_ALG_DEFAULT
  );
  
  // Generate nonce
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  
  // Encrypt
  const ciphertext = s.crypto_secretbox_easy(data, nonce, key);
  
  // Combine salt + nonce + ciphertext and encode to base64
  const combined = Buffer.concat([Buffer.from(salt), Buffer.from(nonce), Buffer.from(ciphertext)]);
  return combined.toString('base64');
}

export async function decrypt(encryptedData: string): Promise<string> {
  try {
    const s = await getSodium();
    
    const combined = Buffer.from(encryptedData, 'base64');
    
    // Se os dados não têm estrutura de libsodium (salt + nonce + ciphertext), assumir Base64 simples
    const saltSize = s.crypto_pwhash_SALTBYTES;
    const nonceSize = s.crypto_secretbox_NONCEBYTES;
    const minSize = saltSize + nonceSize + 1;
    
    if (combined.length < minSize) {
      // Tamanho muito pequeno, provavelmente é Base64 simples
      return Buffer.from(encryptedData, 'base64').toString('utf8');
    }
    
    // Extract salt (first bytes)
    const salt = combined.slice(0, saltSize);
    
    // Extract nonce (next 24 bytes)
    const nonce = combined.slice(saltSize, saltSize + nonceSize);
    
    // Extract ciphertext (rest)
    const ciphertext = combined.slice(saltSize + nonceSize);
    
    // Derive same key
    const key = s.crypto_pwhash(
      32,
      MASTER_KEY,
      salt,
      s.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      s.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      s.crypto_pwhash_ALG_DEFAULT
    );
    
    // Decrypt
    const decrypted = s.crypto_secretbox_open_easy(ciphertext, nonce, key);
    
    return Buffer.from(decrypted).toString('utf8');
  } catch (error) {
    // Se falhar, tentar decodificar como Base64 simples (formato antigo)
    console.warn('Falha ao descriptografar com libsodium, tentando Base64 simples:', error);
    return Buffer.from(encryptedData, 'base64').toString('utf8');
  }
}

