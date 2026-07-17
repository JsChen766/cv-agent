"""Download and validate the local embedding model once.

The resulting directory is intentionally git-ignored and mounted read-only
into the API container by docker-compose.yml.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from huggingface_hub import snapshot_download
from sentence_transformers import SentenceTransformer

DEFAULT_MODEL = "BAAI/bge-small-zh-v1.5"
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "models" / "bge-small-zh-v1.5"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Hugging Face model id")
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="Persistent local model directory",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    snapshot_download(repo_id=args.model, local_dir=output)

    model = SentenceTransformer(str(output), local_files_only=True)
    dimension = model.get_embedding_dimension()
    if dimension != 512:
        raise RuntimeError(f"Unexpected embedding dimension: {dimension}; expected 512")
    model.encode(["本地模型验证"], normalize_embeddings=True, show_progress_bar=False)
    print(f"Embedding model ready: {output} (dimension={dimension})")


if __name__ == "__main__":
    main()
