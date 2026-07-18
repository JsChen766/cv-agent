# Resume regression fixtures

This directory contains reviewed, PII-free fixtures for resume layout and
observability regression tests. It is not a dump of production rows.

## Directory contract

Every valid case listed in `manifest.json` has:

- `structured.json`: the structured resume input, with stable section, item,
  bullet, source-experience, source-fact, and JD-requirement IDs;
- `layout-constraint.json`: the layout constraint used for the sample;
- `layout-report.json`: the saved backend layout result;
- `dom-preview.json`: raw browser-like dimensions. Ratios are recomputed from
  widths by tests/reporters rather than trusted from a client;
- `dom-print.json`: either a measured print observation or an explicit
  `pending` marker during P0;
- `expected.json`: only the behaviorally relevant assertions and tolerances.

The manifest schema is `resume-regression-manifest-v1`. The seven valid P0
cases are deliberately synthetic. `incident_two_page_zh` is a reservation for
the reported screenshot incident and stays `pending/invalid` until an
authorized, width-preserving structured payload and real DOM observation are
available.

## Provenance and privacy rules

- Fixtures must contain no real name, email, phone number, private/internal
  URL, prompt, completion, SQL parameter, API key, or unapproved resume text.
- `fixture_provenance.kind=synthetic` means every fact and metric was built for
  boundary testing. Synthetic DOM dimensions must never be described as a
  real browser incident observation.
- An authorized incident capture must use
  `fixture_provenance.kind=authorized_width_preserving`, carry a review note,
  and preserve character class and approximate glyph width. Replacing Chinese
  text with `***` is not acceptable because it changes wrapping.
- The capture script refuses common PII and never performs automatic
  redaction. If safe replacement would change width class, prepare an
  authorized width-preserving source before capture.

## Expected-pass and known-bad

`expected_pass` means the stored observation is on the passing side of the P0
contract. `known_bad` is an intentional regression target, for example an
underfilled page or a tail ratio below `0.667`. A known-bad fixture passing a
quality gate is a regression; it is not a golden result to refresh away.

## Fonts and profile

All P0 samples use profile `resume-template-v2` with profile hash
`6546b7a86dafbd62a72b82420ba5a4abf08634c6a59c32e1d575f4d1a8c20873`.
Chinese samples declare SimSun and English samples declare Times New Roman.
Synthetic dimensions exercise contracts and boundaries; they do not replace
the real font-loaded DOM calibration required by P4.

## Updating a fixture

1. Explain the behavior change first; do not blindly re-record a golden.
2. Run `scripts/capture_resume_regression_fixture.py --help` and capture from a
   reviewed JSON export. Use `--dom-input` for a separately collected preview
   observation.
3. Verify provenance, profile hash, IDs, width classes, and PII review.
4. Run `pytest tests/unit/test_resume_regression_fixtures.py` and Ruff.
5. Review the canonical hashes added to the manifest.

