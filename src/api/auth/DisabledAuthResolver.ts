import type { FastifyRequest } from "fastify";
import type { AuthResolver, ResolvedAuth } from "./types.js";

export class DisabledAuthResolver implements AuthResolver<FastifyRequest> {
  public async resolve(_request: FastifyRequest): Promise<ResolvedAuth> {
    return {
      user: { id: "test-user", roles: ["user"] },
      auth: { mode: "disabled" },
    };
  }
}
