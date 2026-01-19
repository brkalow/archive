/**
 * Encrypted file-based token storage for platforms without native keychain support.
 * Uses AES-256-GCM encryption with a key derived from machine-specific data.
 *
 * ## Security Considerations
 *
 * This implementation provides "at-rest encryption" but with important limitations:
 *
 * 1. **Predictable key derivation**: The encryption key is derived from machine
 *    identifiers (hostname, username, home directory) that are easily discoverable.
 *    An attacker with access to the encrypted file AND the machine can derive the key.
 *
 * 2. **No user interaction**: Unlike macOS Keychain which prompts for system password
 *    on first access, this storage provides no interactive authentication.
 *
 * 3. **Threat model**: This protects against casual access and ensures tokens aren't
 *    stored in plain text. It does NOT protect against a determined attacker with
 *    local access to both the auth file and machine identifiers.
 *
 * For higher security requirements, consider:
 * - Using macOS on supported platforms (uses secure Keychain)
 * - Running the CLI in ephemeral environments where tokens are short-lived
 * - Future: Adding optional passphrase-based encryption
 *
 * The file is stored at ~/.openctl/auth.enc with mode 0600 (user read/write only).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from "crypto";
import { homedir, hostname, userInfo } from "os";
import type { TokenStore, Tokens } from "./keychain";

const AUTH_FILE_NAME = "auth.enc";
const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

/**
 * Get the path to the encrypted auth file.
 */
function getAuthFilePath(): string {
  const home = Bun.env.HOME || process.env.HOME || homedir();
  return join(home, ".openctl", AUTH_FILE_NAME);
}

/**
 * Get machine-specific identifier for key derivation.
 * Combines hostname, username, and home directory.
 */
function getMachineId(): string {
  const parts = [
    hostname(),
    userInfo().username,
    homedir(),
  ];
  return parts.join("|");
}

/**
 * Derive an encryption key from the machine ID and salt.
 */
function deriveKey(salt: Buffer): Buffer {
  const machineId = getMachineId();
  return scryptSync(machineId, salt, KEY_LENGTH);
}

/**
 * Token storage format on disk.
 */
interface StorageFormat {
  version: number;
  salt: string; // Base64 encoded
  servers: Record<string, {
    iv: string;      // Base64 encoded
    authTag: string; // Base64 encoded
    data: string;    // Base64 encoded encrypted data
  }>;
}

export class FileKeychain implements TokenStore {
  private cache: StorageFormat | null = null;

  async get(serverUrl: string): Promise<Tokens | null> {
    const storage = this.readStorage();
    if (!storage) return null;

    const entry = storage.servers[serverUrl];
    if (!entry) return null;

    try {
      const salt = Buffer.from(storage.salt, "base64");
      const key = deriveKey(salt);
      const iv = Buffer.from(entry.iv, "base64");
      const authTag = Buffer.from(entry.authTag, "base64");
      const encryptedData = Buffer.from(entry.data, "base64");

      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([
        decipher.update(encryptedData),
        decipher.final(),
      ]);

      return JSON.parse(decrypted.toString("utf8")) as Tokens;
    } catch {
      // Decryption failed (corrupted data or different machine)
      return null;
    }
  }

  async set(serverUrl: string, tokens: Tokens): Promise<void> {
    let storage = this.readStorage();

    // Initialize storage if it doesn't exist
    if (!storage) {
      const salt = randomBytes(SALT_LENGTH);
      storage = {
        version: 1,
        salt: salt.toString("base64"),
        servers: {},
      };
    }

    const salt = Buffer.from(storage.salt, "base64");
    const key = deriveKey(salt);
    const iv = randomBytes(IV_LENGTH);

    const cipher = createCipheriv(ALGORITHM, key, iv);
    const plaintext = Buffer.from(JSON.stringify(tokens), "utf8");

    const encrypted = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    storage.servers[serverUrl] = {
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      data: encrypted.toString("base64"),
    };

    this.writeStorage(storage);
  }

  async delete(serverUrl: string): Promise<void> {
    const storage = this.readStorage();
    if (!storage) return;

    delete storage.servers[serverUrl];

    if (Object.keys(storage.servers).length === 0) {
      // Remove file if no more entries
      const filePath = getAuthFilePath();
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
      this.cache = null;
    } else {
      this.writeStorage(storage);
    }
  }

  async list(): Promise<string[]> {
    const storage = this.readStorage();
    if (!storage) return [];
    return Object.keys(storage.servers);
  }

  private readStorage(): StorageFormat | null {
    if (this.cache) return this.cache;

    const filePath = getAuthFilePath();
    if (!existsSync(filePath)) return null;

    try {
      const content = readFileSync(filePath, "utf8");
      this.cache = JSON.parse(content) as StorageFormat;
      return this.cache;
    } catch {
      return null;
    }
  }

  private writeStorage(storage: StorageFormat): void {
    const filePath = getAuthFilePath();
    const dir = dirname(filePath);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(filePath, JSON.stringify(storage, null, 2));
    chmodSync(filePath, 0o600);
    this.cache = storage;
  }
}
