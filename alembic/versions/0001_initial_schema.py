"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-07-04
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── pgvector extension ────────────────────────────────────────────────────
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    # ── users ─────────────────────────────────────────────────────────────────
    op.execute("""
    CREATE TABLE users (
        id          TEXT PRIMARY KEY,
        email       TEXT NOT NULL UNIQUE,
        hashed_password TEXT NOT NULL,
        is_active   BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """)

    op.execute("""
    CREATE TABLE user_profiles (
        user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        full_name           TEXT,
        email               TEXT,
        phone               TEXT,
        location            TEXT,
        linkedin_url        TEXT,
        github_url          TEXT,
        personal_website    TEXT,
        current_title       TEXT,
        current_company     TEXT,
        years_of_experience INTEGER,
        career_stage        TEXT,
        target_roles        JSONB NOT NULL DEFAULT '[]',
        target_industries   JSONB NOT NULL DEFAULT '[]',
        target_locations    JSONB NOT NULL DEFAULT '[]',
        preferred_language  TEXT NOT NULL DEFAULT 'zh-CN',
        resume_style        TEXT,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """)

    # ── experiences ───────────────────────────────────────────────────────────
    op.execute("""
    CREATE TABLE experiences (
        id                  TEXT PRIMARY KEY,
        user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category            TEXT NOT NULL,
        title               TEXT NOT NULL,
        organization        TEXT,
        role                TEXT,
        start_date          DATE,
        end_date            DATE,
        tags                JSONB NOT NULL DEFAULT '[]',
        status              TEXT NOT NULL DEFAULT 'active',
        current_revision_id TEXT,
        embedding           vector(1536),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """)

    op.execute("CREATE INDEX idx_experiences_user_id ON experiences(user_id)")
    op.execute("CREATE INDEX idx_experiences_status ON experiences(status)")
    op.execute(
        "CREATE INDEX idx_experiences_embedding "
        "ON experiences USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)"
    )

    op.execute("""
    CREATE TABLE experience_revisions (
        id              TEXT PRIMARY KEY,
        experience_id   TEXT NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
        content         TEXT NOT NULL,
        source          TEXT NOT NULL DEFAULT 'manual',
        embedding       vector(1536),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """)

    op.execute("""
    CREATE INDEX idx_revisions_experience_id ON experience_revisions(experience_id);
    """)

    # ── import jobs & candidates ──────────────────────────────────────────────
    op.execute("""
    CREATE TABLE import_jobs (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source      TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'processing',
        file_id     TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """)

    op.execute("""
    CREATE TABLE import_candidates (
        id              TEXT PRIMARY KEY,
        import_job_id   TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category        TEXT NOT NULL,
        title           TEXT NOT NULL,
        organization    TEXT,
        role            TEXT,
        content         TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """)

    # ── jd_records ────────────────────────────────────────────────────────────
    op.execute("""
    CREATE TABLE jd_records (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        company     TEXT,
        target_role TEXT,
        raw_text    TEXT NOT NULL,
        requirements JSONB NOT NULL DEFAULT '[]',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """)

    op.execute("CREATE INDEX idx_jd_user_id ON jd_records(user_id);")

    # ── resumes ───────────────────────────────────────────────────────────────
    op.execute("""
    CREATE TABLE resumes (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        target_role TEXT,
        jd_id       TEXT REFERENCES jd_records(id) ON DELETE SET NULL,
        status      TEXT NOT NULL DEFAULT 'draft',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """)

    op.execute("""
    CREATE TABLE resume_items (
        id                    TEXT PRIMARY KEY,
        resume_id             TEXT NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
        section_type          TEXT NOT NULL,
        title                 TEXT,
        content_snapshot      TEXT NOT NULL DEFAULT '',
        order_index           INTEGER NOT NULL DEFAULT 0,
        hidden                BOOLEAN NOT NULL DEFAULT FALSE,
        pinned                BOOLEAN NOT NULL DEFAULT FALSE,
        source_experience_id  TEXT REFERENCES experiences(id) ON DELETE SET NULL,
        source_variant_id     TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """)

    op.execute("CREATE INDEX idx_resume_items_resume_id ON resume_items(resume_id);")

    op.execute("""
    CREATE TABLE resume_variants (
        id               TEXT PRIMARY KEY,
        resume_id        TEXT NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
        jd_id            TEXT REFERENCES jd_records(id) ON DELETE SET NULL,
        title            TEXT NOT NULL,
        content          TEXT NOT NULL,
        score            JSONB NOT NULL DEFAULT '{}',
        evidence_summary JSONB NOT NULL DEFAULT '[]',
        risk_summary     JSONB NOT NULL DEFAULT '[]',
        missing_info     JSONB NOT NULL DEFAULT '[]',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """)

    op.execute("CREATE INDEX idx_variants_resume_id ON resume_variants(resume_id);")

    # ── artifacts ─────────────────────────────────────────────────────────────
    op.execute("""
    CREATE TABLE artifacts (
        id                      TEXT PRIMARY KEY,
        user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type                    TEXT NOT NULL,
        title                   TEXT NOT NULL,
        content                 TEXT NOT NULL,
        source_jd_id            TEXT REFERENCES jd_records(id) ON DELETE SET NULL,
        source_experience_ids   JSONB NOT NULL DEFAULT '[]',
        word_count              INTEGER NOT NULL DEFAULT 0,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """)

    op.execute("CREATE INDEX idx_artifacts_user_id ON artifacts(user_id);")

    # ── preferences ───────────────────────────────────────────────────────────
    op.execute("""
    CREATE TABLE preferences (
        id                   TEXT PRIMARY KEY,
        user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rule                 TEXT NOT NULL,
        category             TEXT NOT NULL,
        source               TEXT NOT NULL,
        priority             INTEGER NOT NULL DEFAULT 50,
        confidence           FLOAT NOT NULL DEFAULT 1.0,
        reinforcement_count  INTEGER NOT NULL DEFAULT 1,
        scope                TEXT NOT NULL DEFAULT 'global',
        active               BOOLEAN NOT NULL DEFAULT TRUE,
        embedding            vector(1536),
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_reinforced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """)

    op.execute("CREATE INDEX idx_preferences_user_id ON preferences(user_id)")
    op.execute("CREATE INDEX idx_preferences_active ON preferences(active)")
    op.execute(
        "CREATE INDEX idx_preferences_embedding "
        "ON preferences USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10)"
    )

    op.execute("""
    CREATE TABLE preference_signals (
        id                   TEXT PRIMARY KEY,
        user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        signal_type          TEXT NOT NULL,
        raw_content          TEXT NOT NULL,
        generation_context   JSONB NOT NULL DEFAULT '{}',
        processed            BOOLEAN NOT NULL DEFAULT FALSE,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """)

    # ── guideline_chunks (RAG) ────────────────────────────────────────────────
    op.execute("""
    CREATE TABLE guideline_chunks (
        id          TEXT PRIMARY KEY,
        content     TEXT NOT NULL,
        source_file TEXT,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        embedding   vector(1536),
        metadata    JSONB NOT NULL DEFAULT '{}',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """)

    op.execute("""
    CREATE INDEX idx_guideline_embedding ON guideline_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
    """)

    # ── files (upload tracking) ───────────────────────────────────────────────
    op.execute("""
    CREATE TABLE uploaded_files (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        filename    TEXT NOT NULL,
        mime_type   TEXT NOT NULL,
        size_bytes  INTEGER NOT NULL DEFAULT 0,
        storage_path TEXT NOT NULL,
        parsed_text TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """)

    # ── sessions (auth) ───────────────────────────────────────────────────────
    op.execute("""
    CREATE TABLE user_sessions (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash  TEXT NOT NULL UNIQUE,
        expires_at  TIMESTAMPTZ NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """)

    op.execute("CREATE INDEX idx_sessions_token_hash ON user_sessions(token_hash);")

    # ── idempotency keys ──────────────────────────────────────────────────────
    op.execute("""
    CREATE TABLE idempotency_keys (
        key         TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        response    JSONB NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at  TIMESTAMPTZ NOT NULL
    )
    """)


def downgrade() -> None:
    for table in [
        "idempotency_keys", "user_sessions", "uploaded_files",
        "guideline_chunks", "preference_signals", "preferences",
        "artifacts", "resume_variants", "resume_items", "resumes",
        "jd_records", "import_candidates", "import_jobs",
        "experience_revisions", "experiences",
        "user_profiles", "users",
    ]:
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
    op.execute("DROP EXTENSION IF EXISTS vector")
