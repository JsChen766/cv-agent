import type { AuthRepository } from "./AuthRepository.js";
import type { AppUser, AuthIdentity, AuthProvider, AuthSession, UserApiKey } from "./types.js";

export class InMemoryAuthRepository implements AuthRepository {
  private readonly users = new Map<string, AppUser>();
  private readonly identities = new Map<string, AuthIdentity>();
  private readonly sessions = new Map<string, AuthSession>();
  private readonly apiKeys = new Map<string, UserApiKey>();

  public async createUser(user: AppUser): Promise<AppUser> {
    this.users.set(user.id, user);
    return user;
  }

  public async getUserById(id: string): Promise<AppUser | null> {
    return this.users.get(id) ?? null;
  }

  public async getUserByEmail(email: string): Promise<AppUser | null> {
    const normalized = email.toLowerCase();
    return Array.from(this.users.values()).find((user) => user.email.toLowerCase() === normalized) ?? null;
  }

  public async updateUser(id: string, patch: Partial<AppUser>): Promise<AppUser | null> {
    const user = this.users.get(id);
    if (!user) return null;
    const next = { ...user, ...patch, updatedAt: new Date().toISOString() };
    this.users.set(id, next);
    return next;
  }

  public async upsertIdentity(identity: AuthIdentity): Promise<AuthIdentity> {
    const key = identityKey(identity.provider, identity.providerUserId);
    const existing = this.identities.get(key);
    const next = existing ? { ...existing, ...identity, id: existing.id, createdAt: existing.createdAt } : identity;
    this.identities.set(key, next);
    return next;
  }

  public async getIdentity(provider: AuthProvider, providerUserId: string): Promise<AuthIdentity | null> {
    return this.identities.get(identityKey(provider, providerUserId)) ?? null;
  }

  public async createSession(session: AuthSession): Promise<AuthSession> {
    this.sessions.set(session.sessionTokenHash, session);
    return session;
  }

  public async getSessionByTokenHash(hash: string): Promise<AuthSession | null> {
    return this.sessions.get(hash) ?? null;
  }

  public async updateSession(id: string, patch: Partial<AuthSession>): Promise<AuthSession | null> {
    const current = Array.from(this.sessions.values()).find((session) => session.id === id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.sessions.delete(current.sessionTokenHash);
    this.sessions.set(next.sessionTokenHash, next);
    return next;
  }

  public async createUserApiKey(key: UserApiKey): Promise<UserApiKey> {
    this.apiKeys.set(key.id, key);
    return key;
  }

  public async listUserApiKeys(userId: string): Promise<UserApiKey[]> {
    return Array.from(this.apiKeys.values()).filter((key) => key.userId === userId && key.status !== "deleted");
  }

  public async getUserApiKey(userId: string, id: string): Promise<UserApiKey | null> {
    const key = this.apiKeys.get(id);
    return key?.userId === userId ? key : null;
  }

  public async updateUserApiKey(userId: string, id: string, patch: Partial<UserApiKey>): Promise<UserApiKey | null> {
    const key = await this.getUserApiKey(userId, id);
    if (!key) return null;
    const next = { ...key, ...patch, updatedAt: new Date().toISOString() };
    this.apiKeys.set(id, next);
    return next;
  }
}

function identityKey(provider: AuthProvider, providerUserId: string): string {
  return `${provider}:${providerUserId}`;
}
