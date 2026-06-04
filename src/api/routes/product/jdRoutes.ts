import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError, ErrorCodes } from "../../errors.js";
import type { ApiKernel } from "../../types.js";
import type { AuthResolver } from "../../auth/index.js";
import { withIdempotency } from "../../idempotency.js";
import {
  productSuccess,
  requireRecord,
  requiredString,
  optionalString,
  param,
  readLimit,
  type ProductRouteContextFn,
} from "./productRouteHelpers.js";

export function registerJDRoutes(
  app: FastifyInstance,
  kernel: ApiKernel,
  contextFor: ProductRouteContextFn,
  _authResolver: AuthResolver<FastifyRequest>,
): void {
  app.get("/product/jds", async (request) => {
    const ctx = await contextFor(request);
    return productSuccess(await kernel.productServices.jdService.listJDs(ctx.user.id, readLimit(request.query)), kernel, ctx);
  });

  app.post("/product/jds", async (request, reply) => {
    const ctx = await contextFor(request);
    const body = requireRecord(request.body);
    return withIdempotency(request, reply, kernel, ctx.user.id, async () => {
      const jd = await kernel.productServices.jdService.saveJD(ctx.user.id, {
        rawText: requiredString(body.rawText ?? body.jdText, "rawText"),
        title: optionalString(body.title),
        company: optionalString(body.company),
        targetRole: optionalString(body.targetRole),
      });
      return productSuccess(jd, kernel, ctx);
    });
  });

  app.get("/product/jds/:id", async (request) => {
    const ctx = await contextFor(request);
    const jd = await kernel.productServices.jdService.getJD(ctx.user.id, param(request, "id"));
    if (!jd) throw new ApiError(ErrorCodes.NOT_FOUND, "JD not found.", 404);
    return productSuccess(jd, kernel, ctx);
  });
}
