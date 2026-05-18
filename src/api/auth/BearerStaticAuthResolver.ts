import type { FastifyRequest } from "fastify";
import { ApiError, ErrorCodes } from "../errors.js";
import type { AuthResolver, ResolvedAuth } from "./types.js";

export class BearerStaticAuthResolver implements AuthResolver<FastifyRequest> {
  public constructor(private readonly token: string, private readonly userId: string) {}

  public async resolve(request: FastifyRequest): Promise<ResolvedAuth> {
    const header = readHeader(request.headers.authorization);
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
    if (!token || token !== this.token) {
      throw new ApiError(ErrorCodes.UNAUTHORIZED, "Invalid bearer token.", 401);
    }
    return {
      user: { id: this.userId, roles: ["user"] },
      auth: { mode: "bearer_static", tokenId: "static" },
    };
  }
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  return value?.find((item) => item.trim().length > 0)?.trim();
}
