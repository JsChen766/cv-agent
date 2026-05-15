import type { FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import type { AuthResolver, ResolvedAuth } from "./types.js";

export class StubCookieSessionAuthResolver implements AuthResolver<FastifyRequest> {
  public async resolve(_request: FastifyRequest): Promise<ResolvedAuth> {
    throw new ApiError("INVALID_AUTH", "Cookie session auth is not implemented yet.", 501);
  }
}
