import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readPlatformConfig } from "../platform/config.js";

export type ApiKeyEncryptor = {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
  mask(plaintext: string): string;
};

export class AesGcmApiKeyEncryptor implements ApiKeyEncryptor {
  public constructor(private readonly configuredSecret?: string) {}

  public encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", keyFromSecret(this.secret()), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
  }

  public decrypt(ciphertext: string): string {
    const [version, ivText, tagText, valueText] = ciphertext.split(".");
    if (version !== "v1" || !ivText || !tagText || !valueText) {
      throw new Error("Unsupported encrypted API key format.");
    }
    const decipher = createDecipheriv("aes-256-gcm", keyFromSecret(this.secret()), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(valueText, "base64url")), decipher.final()]).toString("utf8");
  }

  public mask(plaintext: string): string {
    const tail = plaintext.slice(-4);
    const prefix = plaintext.startsWith("sk-") ? "sk-" : "";
    return `${prefix}****${tail}`;
  }

  private secret(): string {
    return this.configuredSecret ?? readSecret();
  }
}

function keyFromSecret(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function readSecret(): string {
  try {
    const config = readPlatformConfig();
    if (config.userApiKeyEncryptionSecret) return config.userApiKeyEncryptionSecret;
  } catch {
    // config may throw before env is fully set — fall through
  }
  if (process.env.NODE_ENV === "test") return "test-user-api-key-secret";
  throw new Error("USER_API_KEY_ENCRYPTION_SECRET is required to store user API keys.");
}
