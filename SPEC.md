# dep-doctor — technical specification

> Companion to [`README.md`](./README.md). Build document: job state machine,
> strategy chain, per-ecosystem patchers, config schema, cost controls, and the
> migration corpus.

---

## 1. Design invariants

1. **Green-gate is absolute.** A PR is opened only after the target repo's own
   test command passes on the migrated branch. There is no override flag that
   opens red PRs — the tool's entire value proposition is that sentence.
2. **Never fix on red.** If `main` isn't green at the baseline step, dep-doctor
   refuses to act and says why. Migrating on top of a broken baseline produces
   noise.
3. **Explain every patch.** Each change in a PR maps to a reason: a changelog
   entry, a failing test, or a strategy rule. Unexplained diffs are bugs.
4. **Cheapest strategy first.** Deterministic transforms → upstream codemods →
   pattern AST rewrites → model-assisted → `needs-human`. Every stage is
   bounded by a budget; exhaustion degrades gracefully to `needs-human`.
5. **Provenance or it didn't happen.** Every PR carries: baseline sha, exact
   package-manager commands run, test results, and a rollback plan.

## 2. Configuration

`.dep-doctor.yml` at repo root:

```yaml
version: 1

ecosystems:
  - npm
  # - pypi
  # - go

ci:
  test: "pnpm test"          # authoritative oracle; auto-detected if omitted
  build: "pnpm build"        # optional additional gate
  timeout: 900

update:
  strategy: patch-minor-first  # patch-minor-first | all-at-once | security-only
  include: ["*"]
  exclude: ["@acme/*", "left-pad"]         # never touch
  majors: needs-human                        # auto | needs-human | skip
  group:
    enabled: true
    by: ecosystem                            # ecosystem | semver-range
    max-per-pr: 5
  schedule: "0 6 * * 1"                      # weekly

budget:
  attempts-per-dep: 3
  minutes-per-dep: 30
  tokens-per-dep: 200000                     # model-assisted mode only

pr:
  fork: false                    # push to branch on same repo (or fork)
  labels: ["deps", "automated"]
  draft: true                    # open as draft; human promotes
  reviewers: []
  sign: true                     # signed commit w/ configured key
  footer: true                   # attribution footer (removable)

model:
  enabled: false                 # opt-in; must be explicitly enabled
  provider: "anthropic"          # any OpenAI-compatible or Anthropic endpoint
  endpoint: null                 # BYO endpoint; never routes through us
```

Auto-detection fallbacks when `ci.test` is omitted: parse CI workflows
(`.github/workflows`) for the test job command; else `package.json` scripts.test;
else report `needs-human` with a prompt to set it. **Guessing the oracle is
forbidden** — a wrong test command means false greens.

## 3. Job state machine

```
        ┌─────────┐
        │ baseline │──(main red)──► abort(report)
        └────┬────┘
             ▼
        ┌─────────┐
   ┌───►│  plan   │──(nothing)──► done
   │    └────┬────┘
   │         ▼
   │    ┌─────────┐
   │    │ provision│  ephemeral env, cached by lockfile hash
   │    └────┬────┘
   │         ▼
   │    ┌─────────┐
   │    │ apply   │  package manager bump (exact pins honored)
   │    └────┬────┘
   │         ▼
   │    ┌─────────┐
   │    │  test   │──(green)──► open PR ──► record corpus ──► next
   │    └────┬────┘
   │         │(fail)
   │         ▼
   │    ┌─────────┐
   │    │ research │  changelog · migration guide · usage sites
   │    └────┬────┘
   │         ▼
   │    ┌─────────┐
   │    │  patch  │  strategy chain (§4)
   │    └────┬────┘
   │         │(no patch | budget exhausted)
   │         ▼
 │    needs-human PR (research brief, no code change)
   │
   └──(retry budget remains)
```

Job record (SQLite, per repo):

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, repo TEXT, dep TEXT, from_ver TEXT, to_ver TEXT,
  state TEXT, attempts INTEGER, minutes REAL, tokens INTEGER,
  baseline_sha TEXT, final_sha TEXT, pr_number INTEGER,
  failure_sig TEXT, strategy TEXT, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE corpus (            -- the moat
  id TEXT PRIMARY KEY, dep TEXT, from_ver TEXT, to_ver TEXT,
  error_signature TEXT, strategy TEXT, patch_hash TEXT,
  verified INTEGER, used_count INTEGER, contributed_by TEXT
);
```

## 4. Strategy chain

Each strategy receives `(dep, from, to, failure, ctx)` and returns
`Patch | null`. First non-null wins; every attempt is re-tested.

| # | Strategy | How |
|---|----------|-----|
| 1 | **registry-codemod** | upstream-published migration scripts (`npx <pkg>-codemod`, `go fix`, `ruff --fix`, python `--pyupgrade`). Highest fidelity — the library authors wrote it. |
| 2 | **strategy-library** | versioned rules shipped with dep-doctor: `(pkg, fromRange, toRange, errorSignature) → transform`. Data, not code — community-contributable YAML/TS. |
| 3 | **pattern-ast** | ast-grep/jscodeshift/libcst transforms seeded by the research step (renamed identifiers, moved imports, changed option keys, default-value changes). Bounded by usage-site count. |
| 4 | **model-assisted** | opt-in. Prompt = research digest + failure + candidate sites + *repo conventions from `ctxc`*. Output must be a unified diff, applied to a scratch branch, and must pass the oracle. Never auto-merged, always draft. |
| 5 | **needs-human** | emit PR labeled `needs-human` containing: the research brief, failing tests, candidate sites, and options with effort estimates. No code changes. |

Strategy 4 is deliberately last and bounded: it exists because some migrations
are genuinely mechanical-but-unpredictable ("wrap this call in `await`"),
and it should be honest about how often it's needed (target: < 20% of PRs).

## 5. Research step

Inputs: the dependency's changelog + GitHub releases + migration guide for
`from→to`, plus the repo's actual usage sites.

```
1. fetch release notes for all versions in (from, to]
2. extract BREAKING/DEPRECATION sections, API renames, removed exports
3. cross-reference with usage sites (from ctxc.symbols or grep fallback)
4. rank candidate causes: does the failing test touch a changed API?
5. emit ResearchDigest { causes[], migrations[], evidence[] }
```

The digest is included verbatim in the PR body for `needs-human` and is the
context for every strategy. Human maintainers frequently just want the digest —
that alone justifies the tool.

## 6. Per-ecosystem patchers (v1 scope)

| Ecosystem | Patcher stack |
|-----------|---------------|
| npm/pnpm/yarn | jscodeshift + ast-grep (TS/JS), `npx <pkg> codemod`, TS compiler errors as oracle supplement |
| pypi | libcst + `ruff --fix` + `pyupgrade`; mypy/pytest as oracle |
| go | `go fix` + `golangci-lint` autofixes; gofmt; module graph via `go mod tidy` |
| cargo | cargo fix + clippy --fix; semver-checks (`cargo semver-checks`) for API diffs |
| maven/gradle | v2 (plugin ecosystem is its own world) |

Ecosystem support is gated behind a trait (`EcosystemAdapter`) so contributors
can add one in isolation — same shape as ctxc's language adapters.

## 7. PR output contract

Every opened PR body (generated, deterministic):

```markdown
## dep-doctor: zod 3.22.4 → 4.1.0

**Status:** ✅ your test suite passes (214 tests, 6m12s)
**Baseline:** main @ 4b21ac9 (verified green before this change)
**Rollback:** `git revert <sha>` — no data/schema changes involved

### What changed in zod
- BREAKING: `SchemaType.strict` renamed to `passthrough` (v4.0 migration guide)
- Removed deprecated `.passthrough()` alias

### What we changed here
- `src/api/schemas.ts:14` — `strict: true` → `passthrough: true` (rename)
- `src/cli/parse.ts:88` — same rename
- regenerated 3 snapshots via `pnpm test:update`

### How to verify
`pnpm test` (already green above) · manual: `pnpm dev` then POST /users

---
opened by dep-doctor · [why this PR?](link) · `#no-footer`
```

Deterministic, human-auditable, and it reads like a teammate wrote it.

## 8. Security & sandboxing

- All work happens in ephemeral containers: no host mounts, no secrets, no
  network except package registries + GitHub (egress allowlist).
- Model-assisted mode: the repo's code is sent only to the user-configured
  endpoint. No telemetry, no third-party routing, clearly documented.
- PRs are opened as **drafts** by default; a human promotes and merges.
- Fork PRs never run with secrets (GitHub's own rule; we enforce it locally too).
- `sign: true` uses the configured key; provenance metadata is attached.

## 9. Cost controls

- `attempts-per-dep` / `minutes-per-dep` / `tokens-per-dep` budgets; hitting a
  budget yields `needs-human` with what was learned so far (never a silent drop).
- Fleet mode: a global concurrency cap + per-repo scheduling to avoid CI storms.
- Cache: research digests keyed by (dep, from, to) — a second repo hitting the
  same upgrade reuses the research (and eventually the corpus).

## 10. Migration corpus

Every verified migration appends to `corpus`:

```
(dep, from, to, error_signature, strategy, patch_hash, verified)
```

- **Locally** it's a SQLite file; a fleet/enterprise install shares one.
- **Opt-in aggregation** (never default) contributes anonymized tuples to the
  hosted corpus, which powers a free public endpoint:
  `GET /migration/:pkg/:from/:to` → digests + strategies. That endpoint is the
  marketing engine *and* the developer-goodwill engine.
- Corpus entries are only marked `verified` after a green oracle run — this is
  the data quality bar competitors can't match cheaply.

## 11. Test strategy

1. **Strategy fixtures.** For each strategy, a mini-repo fixture with a known
   breaking upgrade; assert the exact patch produced.
2. **Oracle honesty tests.** Fixtures where the test command is wrong/absent —
   must refuse, not false-green.
3. **Budget tests.** Fixtures that can't be fixed must hit `needs-human` within
   budget, with a complete research digest.
4. **Determinism.** Same fixture + same versions ⇒ byte-identical PR body and
   patch (model mode excluded and clearly marked non-deterministic).
5. **Ecosystem matrix (CI, nightly).** For the top 20 npm deps by download
   count with a major release in the last year: attempt upgrade on a fixture
   consumer; publish success-rate as a release metric. This is both a test and
   a marketing artifact.

## 12. Failure modes

| Failure | Behavior |
|---------|----------|
| Baseline red | abort with the failing tests; suggest fixing main first |
| Lockfile conflict / workspace weirdness | report, skip that dep, continue others |
| Test flakiness | rerun once; if still failing, mark `flaky` and never green-gate on it |
| Registry outage | backoff + retry; skip with reason |
| Patch makes things worse | revert attempt, retry next strategy, ultimately `needs-human` |
| Model output invalid diff | reject, record, fall through to `needs-human` |
| Dep removed upstream entirely | `needs-human` with migration guide reference |

## 13. Performance budgets

| Phase | Budget |
|-------|--------|
| plan (per repo) | < 30 s (cached registry metadata) |
| provision (warm) | < 60 s |
| test | repo's suite + overhead < 5% |
| research | < 20 s per dep (cached) |
| patch (strategies 1–3) | < 60 s |
| **fleet, 100 repos nightly** | bounded by configured concurrency; report cost per repo |

## 14. v1 → v2 cut line

v1: npm + pypi, strategies 1–3 + needs-human, grouping, draft PRs, research
digest, corpus (local), Action + self-hosted daemon.

v2: go/cargo, model-assisted mode, corpus endpoint + opt-in aggregation, fleet
dashboard, Renovate handoff mode, SBOM diff + signing, policy engine.
