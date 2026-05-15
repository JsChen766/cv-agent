export type AuthenticatedUser = {
  id: string;
  email?: string;
  displayName?: string;
  roles: string[];
};

export type AuthMode =
  | "dev_header"
  | "cookie_session"
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
