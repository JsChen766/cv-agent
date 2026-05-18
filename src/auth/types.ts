export type AppUserStatus = "active" | "disabled" | "deleted";
export type AuthProvider = "password" | "github" | "google" | "dev" | "static";
export type AuthSessionStatus = "active" | "revoked" | "expired";
export type UserApiKeyProvider = "deepseek" | "openai" | "compatible";
export type UserApiKeyStatus = "active" | "disabled" | "deleted";

export type AppUser = {
  id: string;
  email: string;
  displayName?: string;
  avatarUrl?: string;
  status: AppUserStatus;
  authProvider: AuthProvider;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
};

export type AuthIdentity = {
  id: string;
  userId: string;
  provider: AuthProvider;
  providerUserId: string;
  email?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type AuthSession = {
  id: string;
  userId: string;
  sessionTokenHash: string;
  refreshTokenHash?: string;
  status: AuthSessionStatus;
  userAgent?: string;
  ip?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  revokedAt?: string;
};

export type UserApiKey = {
  id: string;
  userId: string;
  provider: UserApiKeyProvider;
  label: string;
  encryptedApiKey: string;
  baseUrl?: string;
  model?: string;
  status: UserApiKeyStatus;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
};

export type UserApiKeySummary = Omit<UserApiKey, "encryptedApiKey"> & {
  maskedKey: string;
};

export type ResolvedUserModelConfig = {
  provider?: UserApiKeyProvider;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};
