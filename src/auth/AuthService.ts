import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ApiKeyEncryptor } from "./ApiKeyEncryptor.js";
import { AesGcmApiKeyEncryptor } from "./ApiKeyEncryptor.js";
import type { AuthRepository } from "./AuthRepository.js";
import type { AppUser, AuthProvider, AuthSession, ResolvedUserModelConfig, UserApiKey, UserApiKeyProvider, UserApiKeySummary } from "./types.js";
import { readPlatformConfig, type PlatformConfig } from "../platform/config.js";

export type AuthServiceConfig = Pick<PlatformConfig, "sessionCookieName" | "sessionTtlDays" | "userApiKeyEncryptionSecret">;

export class AuthService {
  public constructor(
    private readonly repository: AuthRepository,
    private readonly encryptor: ApiKeyEncryptor = new AesGcmApiKeyEncryptor(),
    private readonly config: AuthServiceConfig = readPlatformConfig(),
  ) {}

  public async createUser(input: {
    email: string;
    displayName?: string;
    avatarUrl?: string;
    authProvider?: AuthProvider;
  }): Promise<AppUser> {
    const existing = await this.repository.getUserByEmail(input.email);
    if (existing) return existing;
    const now = new Date().toISOString();
    return this.repository.createUser({
      id: `user-${randomUUID()}`,
      email: input.email,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      status: "active",
      authProvider: input.authProvider ?? "dev",
      createdAt: now,
      updatedAt: now,
    });
  }

  public getUserById(id: string): Promise<AppUser | null> {
    return this.repository.getUserById(id);
  }

  public getUserByEmail(email: string): Promise<AppUser | null> {
    return this.repository.getUserByEmail(email);
  }

  public async upsertIdentity(input: { userId: string; provider: AuthProvider; providerUserId: string; email?: string; metadata?: Record<string, unknown> }) {
    const now = new Date().toISOString();
    return this.repository.upsertIdentity({
      id: `ident-${randomUUID()}`,
      userId: input.userId,
      provider: input.provider,
      providerUserId: input.providerUserId,
      email: input.email,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    });
  }

  public async createSession(input: { userId: string; userAgent?: string; ip?: string; ttlDays?: number }): Promise<{ session: AuthSession; token: string }> {
    const token = `sess_${randomBytes(32).toString("base64url")}`;
    const now = new Date();
    const session: AuthSession = {
      id: `session-${randomUUID()}`,
      userId: input.userId,
      sessionTokenHash: hashToken(token),
      status: "active",
      userAgent: input.userAgent,
      ip: input.ip,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (input.ttlDays ?? this.config.sessionTtlDays) * 24 * 60 * 60 * 1000).toISOString(),
    };
    await this.repository.createSession(session);
    await this.repository.updateUser(input.userId, { lastLoginAt: now.toISOString() });
    return { session, token };
  }

  public async validateSessionToken(token: string): Promise<AppUser | null> {
    const session = await this.repository.getSessionByTokenHash(hashToken(token));
    if (!session || session.status !== "active" || new Date(session.expiresAt).getTime() <= Date.now()) {
      if (session?.status === "active") await this.repository.updateSession(session.id, { status: "expired" });
      return null;
    }
    const user = await this.repository.getUserById(session.userId);
    return user?.status === "active" ? user : null;
  }

  public async revokeSession(token: string): Promise<void> {
    const session = await this.repository.getSessionByTokenHash(hashToken(token));
    if (session) await this.repository.updateSession(session.id, { status: "revoked", revokedAt: new Date().toISOString() });
  }

  public async createUserApiKey(userId: string, input: { provider: UserApiKeyProvider; label: string; apiKey: string; baseUrl?: string; model?: string }): Promise<UserApiKeySummary> {
    const now = new Date().toISOString();
    const record = await this.repository.createUserApiKey({
      id: `uapikey-${randomUUID()}`,
      userId,
      provider: input.provider,
      label: input.label.trim() || input.provider,
      encryptedApiKey: this.encryptor.encrypt(input.apiKey),
      baseUrl: input.baseUrl,
      model: input.model,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return this.toSummary(record);
  }

  public async listUserApiKeys(userId: string): Promise<UserApiKeySummary[]> {
    return Promise.all((await this.repository.listUserApiKeys(userId)).map((key) => this.toSummary(key)));
  }

  public async disableUserApiKey(userId: string, id: string): Promise<UserApiKeySummary | null> {
    const key = await this.repository.updateUserApiKey(userId, id, { status: "disabled" });
    return key ? this.toSummary(key) : null;
  }

  public async resolveUserModelConfig(userId: string): Promise<ResolvedUserModelConfig> {
    const key = (await this.repository.listUserApiKeys(userId)).find((item) => item.status === "active");
    if (!key) return {};
    await this.repository.updateUserApiKey(userId, key.id, { lastUsedAt: new Date().toISOString() });
    return {
      provider: key.provider,
      apiKey: this.encryptor.decrypt(key.encryptedApiKey),
      baseUrl: key.baseUrl,
      model: key.model,
    };
  }

  private toSummary(key: UserApiKey): UserApiKeySummary {
    return {
      id: key.id,
      userId: key.userId,
      provider: key.provider,
      label: key.label,
      baseUrl: key.baseUrl,
      model: key.model,
      status: key.status,
      createdAt: key.createdAt,
      updatedAt: key.updatedAt,
      lastUsedAt: key.lastUsedAt,
      maskedKey: this.encryptor.mask(this.encryptor.decrypt(key.encryptedApiKey)),
    };
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

let _defaultSessionCookieName = "coolto_session";

export function readSessionCookieName(): string {
  try {
    return readPlatformConfig().sessionCookieName;
  } catch {
    return _defaultSessionCookieName;
  }
}

export function setDefaultSessionCookieName(name: string): void {
  _defaultSessionCookieName = name;
}
