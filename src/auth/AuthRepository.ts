import type { AppUser, AuthIdentity, AuthProvider, AuthSession, UserApiKey } from "./types.js";

export type AuthRepository = {
  createUser(user: AppUser): Promise<AppUser>;
  getUserById(id: string): Promise<AppUser | null>;
  getUserByEmail(email: string): Promise<AppUser | null>;
  updateUser(id: string, patch: Partial<AppUser>): Promise<AppUser | null>;
  upsertIdentity(identity: AuthIdentity): Promise<AuthIdentity>;
  getIdentity(provider: AuthProvider, providerUserId: string): Promise<AuthIdentity | null>;
  createSession(session: AuthSession): Promise<AuthSession>;
  getSessionByTokenHash(hash: string): Promise<AuthSession | null>;
  updateSession(id: string, patch: Partial<AuthSession>): Promise<AuthSession | null>;
  createUserApiKey(key: UserApiKey): Promise<UserApiKey>;
  listUserApiKeys(userId: string): Promise<UserApiKey[]>;
  getUserApiKey(userId: string, id: string): Promise<UserApiKey | null>;
  updateUserApiKey(userId: string, id: string, patch: Partial<UserApiKey>): Promise<UserApiKey | null>;
};
