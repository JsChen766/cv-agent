export type AuthenticatedUser = {
  id: string;
  email?: string;
  displayName?: string;
  roles: string[];
};

export type AuthMode =
  | "dev_header"
  | "disabled"
  | "cookie_session"
  | "bearer_static"
  | "bearer_token"
  | "service";

export type AuthContext = {
  mode: AuthMode;
  sessionId?: string;
  tokenId?: string;
};

export type ResolvedAuth = {
  user: AuthenticatedUser;
  auth: AuthContext;
};

export type AuthResolver<Request = unknown> = {
  resolve(request: Request): Promise<ResolvedAuth>;
};

export function assertAuthenticated(auth: ResolvedAuth): ResolvedAuth {
  if (!auth.user.id) {
    throw new Error("Authenticated user is required.");
  }
  return auth;
}
