"""FastAPI application entry point."""

from __future__ import annotations

import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.middleware.request_id import RequestIdMiddleware
from app.api.routes.auth import router as auth_router
from app.api.routes.copilot import router as copilot_router
from app.api.routes.files import router as files_router
from app.api.routes.product.artifact import router as artifact_router
from app.api.routes.product.experience import router as experience_router
from app.api.routes.product.jd import router as jd_router
from app.api.routes.product.resume import router as resume_router
from app.api.routes.threads import router as threads_router
from app.api.routes.users import router as users_router
from app.core.config import settings
from app.core.errors import AppError

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # Startup
    from app.infra.db.checkpointer import close_checkpointer, create_checkpointer
    from app.infra.db.connection import close_pool, create_pool
    from app.infra.files.parser import warm_file_parsers

    if settings.environment == "production":
        if len(settings.secret_key) < 32 or settings.secret_key.startswith(
            "change-me-in-production"
        ):
            raise RuntimeError("SECRET_KEY must be configured for production")
        if "*" in settings.cors_origins:
            raise RuntimeError("Wildcard CORS origins are not allowed with credentials")

    factbank_worker: Any | None = None
    try:
        pool = await create_pool()
    except Exception as e:
        if settings.environment == "production":
            raise RuntimeError("Database pool is required in production") from e
        logger.warning("DB pool init failed (running without DB): %s", e)
    else:
        if settings.factbank_worker_enabled:
            try:
                from app.infra.db.repositories.factbank_repo import (
                    PostgresFactBankRepository,
                )
                from app.providers.factory import get_embedding_provider, get_provider
                from app.rag.evidence.fact_extractor import StructuredFactExtractor
                from app.rag.evidence.factbank_processor import FactBankProcessor
                from app.rag.evidence.factbank_worker import FactBankWorker

                factbank_repository = PostgresFactBankRepository(pool)
                factbank_processor = FactBankProcessor(
                    factbank_repository,
                    StructuredFactExtractor(get_provider()),
                    get_embedding_provider(),
                    schema_version=settings.factbank_schema_version,
                    extractor_version=settings.factbank_extractor_version,
                    embedding_model=settings.embedding_model,
                    extraction_deadline_seconds=settings.factbank_extraction_deadline_seconds,
                )
                factbank_worker = FactBankWorker(
                    factbank_repository,
                    factbank_processor,
                    schema_version=settings.factbank_schema_version,
                    extractor_version=settings.factbank_extractor_version,
                    embedding_model=settings.embedding_model,
                    concurrency=settings.factbank_worker_concurrency,
                    poll_interval_seconds=settings.factbank_poll_interval_seconds,
                    lease_seconds=settings.factbank_lease_seconds,
                    max_attempts=settings.factbank_max_attempts,
                    legacy_backfill_batch_size=settings.factbank_legacy_backfill_batch_size,
                )
                factbank_worker.start()
            except Exception as e:
                if settings.environment == "production":
                    raise RuntimeError("FactBank worker is required in production") from e
                logger.warning("FactBank worker init failed: %s", e)
    try:
        await create_checkpointer()
    except Exception as e:
        if settings.environment == "production":
            raise RuntimeError("Persistent LangGraph checkpointer is required in production") from e
        logger.warning(
            "LangGraph checkpointer init failed (interrupt resume may be unavailable): %s", e
        )
    try:
        warm_file_parsers()
    except Exception as e:
        logger.warning("File parser warm-up failed (parsing may be unavailable): %s", e)
    yield
    # Shutdown
    if factbank_worker is not None:
        await factbank_worker.stop()
    await close_checkpointer()
    await close_pool()


app = FastAPI(
    title="CV Assistant Backend",
    version="0.1.0",
    docs_url="/docs" if settings.environment == "development" else None,
    redoc_url=None,
    lifespan=lifespan,
)

# ── CORS ──────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Global error handler ──────────────────────────────────────────────────────
@app.exception_handler(AppError)
async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.http_status,
        content={
            "success": False,
            "error": exc.to_dict(),
            "request_id": request.headers.get("X-Request-Id", ""),
        },
    )


# ── Health check ──────────────────────────────────────────────────────────────
@app.get("/v1/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": "0.1.0"}


# ── Middleware ────────────────────────────────────────────────────────────────
app.add_middleware(RequestIdMiddleware)

# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(auth_router, prefix="/v1")
app.include_router(users_router, prefix="/v1")
app.include_router(files_router, prefix="/v1")
app.include_router(experience_router, prefix="/v1")
app.include_router(jd_router, prefix="/v1")
app.include_router(resume_router, prefix="/v1")
app.include_router(artifact_router, prefix="/v1")
app.include_router(copilot_router, prefix="/v1")
app.include_router(threads_router, prefix="/v1")
