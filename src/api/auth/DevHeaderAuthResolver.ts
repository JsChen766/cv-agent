import type { FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import type { AuthResolver, ResolvedAuth } from "./types.js";

export class DevHeaderAuthResolver implements AuthResolver<FastifyRequest> {
  public async resolve(request: FastifyRequest): Promise<ResolvedAuth> {
    const userId = readHeader(request.headers["x-user-id"]);
    if (!userId) {
      throw new ApiError("MISSING_AUTH", "x-user-id header is required in dev auth mode.", 401);
    }
    return {
      user: {
        id: userId,
        roles: ["user"],
      },
      auth: {
        mode: "dev_header",
      },
    };
  }
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const firstValue = value?.find((item) => item.trim().length > 0);
  return firstValue?.trim();
}
