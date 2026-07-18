from __future__ import annotations

from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Database
    database_url: str = "postgresql+asyncpg://cvbe:cvbe@localhost:5432/cvbe"

    # Security
    secret_key: str = "change-me-in-production"
    access_token_expire_minutes: int = 60 * 24 * 7  # 7 days

    # LLM
    llm_provider: Literal["openai", "anthropic"] = "openai"
    llm_model: str = "gpt-4o"
    llm_api_key: str = ""
    llm_base_url: str | None = None  # override for openai-compatible vendors

    # Embeddings
    embedding_provider: Literal["local", "openai"] = "local"
    embedding_model: str = "BAAI/bge-small-zh-v1.5"
    embedding_api_key: str | None = None
    embedding_base_url: str | None = None
    embedding_dimensions: int = 512
    embedding_local_files_only: bool = False

    # RAG
    evidence_similarity_threshold: float = 0.65
    preference_dedup_threshold: float = 0.85
    context_token_budget: int = 16000
    max_self_review_iterations: int = 1
    max_layout_revision_iterations: int = 1
    max_resume_generation_calls: int = 2
    max_resume_local_repair_calls: int = Field(default=1, ge=0, le=1)
    resume_layout_hard_gate_enabled: bool = False
    resume_min_page_usage_ratio: float = Field(default=0.80, ge=0.0, le=1.0)
    resume_target_page_usage_ratio: float = Field(default=0.88, ge=0.0, le=1.0)
    resume_max_page_usage_ratio: float = Field(default=0.95, ge=0.0, le=1.0)
    resume_candidate_pool_target_ratio: float = Field(default=1.20, ge=1.0)
    # Staged A/B path: generate independent experience bullet pools concurrently,
    # then assemble one deterministic resume. Keep disabled until production
    # latency/quality baselines confirm the provider has sufficient concurrency.
    resume_parallel_generation_enabled: bool = False
    resume_generation_max_concurrency: int = Field(default=3, ge=1, le=4)
    resume_parallel_min_experiences: int = Field(default=2, ge=2, le=4)
    # Enable only when the frontend preview/print renderer supports resume-sparse-v1.
    resume_sparse_template_enabled: bool = False

    # Resume generation observability (P0). Raw payload capture is never
    # permitted in production, even if an environment variable enables it.
    resume_observability_enabled: bool = True
    resume_observability_capture_payloads: bool = False
    resume_observability_sample_rate: float = Field(default=1.0, ge=0.0, le=1.0)
    llm_max_transport_retries: int = Field(default=3, ge=0, le=10)
    embedding_max_transport_retries: int = Field(default=3, ge=0, le=10)

    # Files
    file_parse_timeout_seconds: float = Field(default=60.0, gt=0)

    # App
    environment: Literal["development", "production"] = "development"
    cors_origins: list[str] = ["http://localhost:3000", "http://localhost:5173"]

    # Dev mode — auto-auth when ENVIRONMENT=development and no token provided
    dev_auto_auth: bool = False
    dev_user_id: str = "dev-user"

    @model_validator(mode="after")
    def disable_production_payload_capture(self) -> Settings:
        if self.environment == "production":
            self.resume_observability_capture_payloads = False
        return self


settings = Settings()
