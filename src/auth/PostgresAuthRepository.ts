import type { PostgresQueryable } from "../persistence/postgres/PostgresDatabase.js";
import type { AuthRepository } from "./AuthRepository.js";
import type { AppUser, AuthIdentity, AuthProvider, AuthSession, UserApiKey } from "./types.js";

export class PostgresAuthRepository implements AuthRepository {
  public constructor(private readonly database: PostgresQueryable) {}

  public async createUser(user: AppUser): Promise<AppUser> {
    await this.database.query(
      `INSERT INTO app_user (id,email,display_name,avatar_url,status,auth_provider,created_at,updated_at,last_login_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (email) DO UPDATE SET display_name=EXCLUDED.display_name, updated_at=EXCLUDED.updated_at
       RETURNING *`,
      [user.id, user.email, user.displayName ?? null, user.avatarUrl ?? null, user.status, user.authProvider, user.createdAt, user.updatedAt, user.lastLoginAt ?? null],
    );
    return (await this.getUserByEmail(user.email)) ?? user;
  }

  public async getUserById(id: string): Promise<AppUser | null> {
    const result = await this.database.query<any>(`SELECT * FROM app_user WHERE id=$1`, [id]);
    return result.rows[0] ? toUser(result.rows[0]) : null;
  }

  public async getUserByEmail(email: string): Promise<AppUser | null> {
    const result = await this.database.query<any>(`SELECT * FROM app_user WHERE lower(email)=lower($1)`, [email]);
    return result.rows[0] ? toUser(result.rows[0]) : null;
  }

  public async updateUser(id: string, patch: Partial<AppUser>): Promise<AppUser | null> {
    await this.database.query(
      `UPDATE app_user SET display_name=COALESCE($2,display_name), avatar_url=COALESCE($3,avatar_url), status=COALESCE($4,status), last_login_at=COALESCE($5,last_login_at), updated_at=$6 WHERE id=$1`,
      [id, patch.displayName ?? null, patch.avatarUrl ?? null, patch.status ?? null, patch.lastLoginAt ?? null, new Date().toISOString()],
    );
    return this.getUserById(id);
  }

  public async upsertIdentity(identity: AuthIdentity): Promise<AuthIdentity> {
    const result = await this.database.query<any>(
      `INSERT INTO auth_identity (id,user_id,provider,provider_user_id,email,metadata_json,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (provider, provider_user_id)
       DO UPDATE SET user_id=EXCLUDED.user_id, email=EXCLUDED.email, metadata_json=EXCLUDED.metadata_json, updated_at=EXCLUDED.updated_at
       RETURNING *`,
      [identity.id, identity.userId, identity.provider, identity.providerUserId, identity.email ?? null, JSON.stringify(identity.metadata ?? {}), identity.createdAt, identity.updatedAt],
    );
    return toIdentity(result.rows[0]);
  }

  public async getIdentity(provider: AuthProvider, providerUserId: string): Promise<AuthIdentity | null> {
    const result = await this.database.query<any>(`SELECT * FROM auth_identity WHERE provider=$1 AND provider_user_id=$2`, [provider, providerUserId]);
    return result.rows[0] ? toIdentity(result.rows[0]) : null;
  }

  public async createSession(session: AuthSession): Promise<AuthSession> {
    await this.database.query(
      `INSERT INTO auth_session (id,user_id,session_token_hash,refresh_token_hash,status,user_agent,ip,created_at,updated_at,expires_at,revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [session.id, session.userId, session.sessionTokenHash, session.refreshTokenHash ?? null, session.status, session.userAgent ?? null, session.ip ?? null, session.createdAt, session.updatedAt, session.expiresAt, session.revokedAt ?? null],
    );
    return session;
  }

  public async getSessionByTokenHash(hash: string): Promise<AuthSession | null> {
    const result = await this.database.query<any>(`SELECT * FROM auth_session WHERE session_token_hash=$1`, [hash]);
    return result.rows[0] ? toSession(result.rows[0]) : null;
  }

  public async updateSession(id: string, patch: Partial<AuthSession>): Promise<AuthSession | null> {
    await this.database.query(
      `UPDATE auth_session SET status=COALESCE($2,status), revoked_at=COALESCE($3,revoked_at), updated_at=$4 WHERE id=$1`,
      [id, patch.status ?? null, patch.revokedAt ?? null, new Date().toISOString()],
    );
    const result = await this.database.query<any>(`SELECT * FROM auth_session WHERE id=$1`, [id]);
    return result.rows[0] ? toSession(result.rows[0]) : null;
  }

  public async createUserApiKey(key: UserApiKey): Promise<UserApiKey> {
    await this.database.query(
      `INSERT INTO user_api_key (id,user_id,provider,label,encrypted_api_key,base_url,model,status,created_at,updated_at,last_used_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [key.id, key.userId, key.provider, key.label, key.encryptedApiKey, key.baseUrl ?? null, key.model ?? null, key.status, key.createdAt, key.updatedAt, key.lastUsedAt ?? null],
    );
    return key;
  }

  public async listUserApiKeys(userId: string): Promise<UserApiKey[]> {
    const result = await this.database.query<any>(`SELECT * FROM user_api_key WHERE user_id=$1 AND status <> 'deleted' ORDER BY created_at DESC`, [userId]);
    return result.rows.map(toApiKey);
  }

  public async getUserApiKey(userId: string, id: string): Promise<UserApiKey | null> {
    const result = await this.database.query<any>(`SELECT * FROM user_api_key WHERE user_id=$1 AND id=$2`, [userId, id]);
    return result.rows[0] ? toApiKey(result.rows[0]) : null;
  }

  public async updateUserApiKey(userId: string, id: string, patch: Partial<UserApiKey>): Promise<UserApiKey | null> {
    await this.database.query(
      `UPDATE user_api_key SET status=COALESCE($3,status), last_used_at=COALESCE($4,last_used_at), updated_at=$5 WHERE user_id=$1 AND id=$2`,
      [userId, id, patch.status ?? null, patch.lastUsedAt ?? null, new Date().toISOString()],
    );
    return this.getUserApiKey(userId, id);
  }
}

function toUser(row: any): AppUser {
  return { id: row.id, email: row.email, displayName: row.display_name ?? undefined, avatarUrl: row.avatar_url ?? undefined, status: row.status, authProvider: row.auth_provider, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : undefined };
}

function toIdentity(row: any): AuthIdentity {
  return { id: row.id, userId: row.user_id, provider: row.provider, providerUserId: row.provider_user_id, email: row.email ?? undefined, metadata: row.metadata_json ?? undefined, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
}

function toSession(row: any): AuthSession {
  return { id: row.id, userId: row.user_id, sessionTokenHash: row.session_token_hash, refreshTokenHash: row.refresh_token_hash ?? undefined, status: row.status, userAgent: row.user_agent ?? undefined, ip: row.ip ?? undefined, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(), revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : undefined };
}

function toApiKey(row: any): UserApiKey {
  return { id: row.id, userId: row.user_id, provider: row.provider, label: row.label, encryptedApiKey: row.encrypted_api_key, baseUrl: row.base_url ?? undefined, model: row.model ?? undefined, status: row.status, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : undefined };
}
