# Resume generation P0 baseline

**Status:** pending / invalid for performance comparison

No end-to-end latency percentile is published yet. The repository currently
does not contain a fixed-environment export with at least 30 valid persisted
runs and matching DOM observations. Publishing made-up p50/p95 values would
make the later P1/P2 comparison invalid.

The committed JSON file is a machine-readable pending marker. To establish the
baseline, collect two warmups followed by at least 30 valid runs, then run:

```text
python scripts/benchmark_resume_generation.py \
  --input artifacts/resume-observability/runs.json \
  --warmup 2 --runs 30 --require-dom \
  --output docs/baselines/resume-generation-p0-baseline.local.json
```

Review the local output for environment fingerprint, profile consistency,
invalid samples, outcome distribution, nearest-rank latency percentiles,
critical-path stage time, LLM logical/protocol/physical counts, tokens, and
backend-vs-DOM differences. Only replace the pending baseline after that review.

