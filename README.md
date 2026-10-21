# dep-doctor — the upgrade bot that finishes the job

> **Dependabot and Renovate *open* PRs. dep-doctor *lands* them.**
> It runs your CI, reads the migration guides, writes the actual migration patch,
> and only opens a PR once your test suite is green.

**Archetype:** GitHub Action + self-hostable daemon · **Buzz:** 🔥🔥🔥 · **Moat:** migration data + CI feedback loop

---

## The problem

Every team knows this scene:

- **Monday:** Renovate opens 31 PRs.
- **Tuesday:** 24 of them fail CI for real reasons — a renamed option, a dropped
  Node version, a changed default, a removed deep import.
- **Wednesday:** a human spends half a day reading changelogs and guessing.
- **Thursday:** 19 PRs are silently closed with "we'll do the big bump later."
- **Forever:** "later" never comes, and the project runs 14 months of
  CVEs behind because *upgrading has negative expected value.*

The bots optimize for *opening* PRs. The cost lives in *finishing* them. Security
pressure makes this worse — you must upgrade, but the work is unbounded.

Meanwhile the fix is embarrassingly mechanical for a machine that can read
changelogs, run tests, and see stack traces.

## The idea

```bash
$ dep-doctor run --ecosystem npm
  ├─ baseline      CI green on main at 4b21ac9            ✅
  ├─ plan          31 outdated · 24 will break · grouped into 9 PRs
  ├─ attempt 1     zod 3.22 → 4.1
  │    CI          ❌  2 failures
  │                  ZodError: "strict" is not a valid SchemaType option
  │    research    changelog v4.0 #breaking → `strict` renamed to `passthrough`
  │                  occurrences: src/api/schemas.ts:14, src/cli/parse.ts:88
  │    patch       ast-grep: rename option + update type import            ✅
  │    CI          ❌  1 failure (snapshot mismatch)
  │    patch       regenerate 3 snapshots via repo script                  ✅
  │    CI          ✅  214 tests · 6m12s
  ├─ open PR       #4821  "chore(deps): zod 3.22 → 4.1 (migration included)"
  │                body: what changed, why the patch, how to verify, rollback
  └─ summary       9 PRs opened · 5 already green · 4 needed migrations
                   22 skipped with reasons (needs human: webpack 4 → 5)
```

Key properties:

- **Test-gated.** A PR is only opened when *your* suite passes. No more
  red-to-green ritual.
- **Migration-aware.** It reads release notes, migration guides, and your
  codebase, then proposes a real patch — AST transforms first, model-assisted
  patching second, human escalation last.
- **Honest about the hard ones.** Some upgrades are genuinely unbounded. It
  labels those `needs-human` with a research brief instead of spamming you.

## Why it wins

- **It flips the economics of the update bot.** Today, updating = unpaid labor.
  With dep-doctor, updating = reviewing a green PR with an explanation attached.
  That single change unlocks years of accumulated upgrade debt.
- **The migration corpus is a compounding moat.** Every successful
  migration → (library version A→B, error signature, patch) tuple improves
  suggestion quality for everyone. Nobody else is collecting that labeled data
  *with a CI-verified outcome*.
- **It sits on top of the tools people already use.** Configure as a Renovate
  replacement *or* as a second stage that picks up where Renovate fails. Zero
  migration cost for adopters.
- **Security urgency is a permanent tailwind.** Every CVE advisory is a reason
  to install this, and the reason never stops arriving.

## Who wants it

| Who | Job to be done |
|-----|----------------|
| Solo maintainers | "I have 200 stars and no time; keep me current" |
| Small teams | "Security wants upgrades but nobody owns them" |
| Platform/infra teams | "300 repos, identical upgrade debt" |
| Foundations | "Keep our ecosystem's supply chain from rotting" |

## Features

**v0 (weekend):** npm ecosystem only. Baseline CI check → `npm outdated` →
apply bump → run test command → on failure, print the failing test + the
changelog diff for the package. No patching yet. Already useful as a triage tool.

**v1:**
- AST patch strategies for the top 10 npm breaking changes (renamed options,
  moved exports, changed defaults) via `ast-grep`/`jscodeshift`
- PR body generator: migration summary, patch explanation, verification steps,
  rollback plan
- grouping + `needs-human` labelling + cost budget per attempt
- GitHub Action + self-hosted runner mode
- pnpm / yarn workspaces support

**v2:**
- Python (pip/uv/poetry) and Go ecosystems
- model-assisted patching behind an explicit flag (runs in your infra, never
  trains on your code)
- `ctxc` integration: locate every usage of a changed API instantly
- cross-repo fleet mode for orgs ("all 300 repos, one dashboard")
- provenance: signed commits, SBOM diff attached to every PR
- Renovate handoff mode: consumes Renovate's plan, adds the finishing layer

## Architecture

```
┌─────────────────────────── control plane ───────────────────────────┐
│ scheduler · repo config (.dep-doctor.yml) · budget/cost accounting   │
└──────────────┬───────────────────────────────────────────────────────┘
               ▼
┌─────────────────────────── job pipeline ────────────────────────────┐
│ 1 baseline      verify main is green (never fix on red)              │
│ 2 plan          outdated set → groupings → urgency (CVE-aware)       │
│ 3 provision     ephemeral CI mirror (container, lockfile-hash cache) │
│ 4 apply bump    package manager, exact version pin                   │
│ 5 test          full suite · parse failures into structured signals  │
│ 6 research      changelog · migration guide · repo usage sites      │
│ 7 patch         strategy chain: codemod → AST rewrite → model patch  │
│ 8 retest        → loop to 5 while budget remains                     │
│ 9 open          green PR only · signed · explained · rollback noted  │
│ 10 record       (lib A→B, error sig, patch) → migration corpus       │
└──────────────────────────────────────────────────────────────────────┘
```

Failure signals are **structured**, not scraped from logs: exit codes, test
names, stack frames, type errors, and lint diagnostics are normalized into a
`Failure` object the research step can query.

The **strategy chain** is deliberately ordered cheapest-first:
1. pure rename / import move (deterministic, from a versioned strategy library)
2. codemod from the library's own published migration script (many upstreams
   ship one — it's the highest-quality signal available)
3. pattern-based AST rewrite with tests as the oracle
4. model-assisted patch (opt-in; produces a *diff proposal*, always re-tested)
5. `needs-human` with a written research brief

Nothing skips the oracle. **A patch that doesn't turn CI green is not a patch.**

## Growth loop

1. **Green PRs are the marketing.** A maintainer merges a migration-included
   upgrade PR and tells someone. Every PR body ends with a one-line
   attribution footer (removable).
2. **Renovate/Dependabot users are pre-qualified.** Install alongside, keep
   their config, take over only the failures. Lowest-friction wedge imaginable.
3. **CVE advisory events.** Publish "the npm ecosystem's most-in-debt packages"
   quarterly; each advisory wave sends people searching for exactly this.
4. **Migration corpus becomes a public API.** `GET /migration/:pkg/:from/:to` —
   free for open source, the corpus is your moat and your content.

## Competitors & wedge

| Existing | Gap you exploit |
|----------|-----------------|
| Renovate / Dependabot | Open PRs, never finish them; no test gate, no migration |
| Snyk / Socket / bulk-update bots | Security-first, still leave the human the work |
| Greenkeeper (RIP) | Died doing exactly this, but pre-agent, pre-cheap-CI |
| "AI upgrade" startups | Closed, SaaS-only, can't run in your infra |

**Wedge:** *green PR or no PR*, self-hostable, honest `needs-human` escape hatch.

## 48-hour MVP

1. **Day 1 AM:** Action that runs on schedule: `npm outdated` → for each package,
   apply bump in a scratch branch → run the configured test command → collect
   results.
2. **Day 1 PM:** triage report: which bumps are already green (open PR
   immediately — instant value), which fail, with the structured failure.
3. **Day 2 AM:** research step: pull the changelog + GitHub releases for the
   package version range, extract `BREAKING` sections, grep your codebase for
   the symbols mentioned.
4. **Day 2 PM:** run against 5 real repos with heavy dependency debt, screenshot
   the outcomes, publish the results honestly (including what it couldn't fix).

## Monetization (open core)

- Free: self-hosted Action/daemon, npm ecosystem, all strategies, forever.
- **Team:** hosted scheduler, dashboard across repos, fleet mode, private
  migration-corpus cache, cost analytics.
- **Enterprise:** air-gapped corpus mirror, custom strategy packs, policy engine
  ("never auto-upgrade majors of X"), audit trail, SSO, support SLA.

## Risks

- **Executing untrusted code in CI.** Mitigate: ephemeral containers, no
  secrets on fork-style runs, network egress rules, resource limits.
- **Bad patches erode trust faster than no patches.** Mitigate: green-gate is
  absolute; every patch is explained; `needs-human` is the default answer, not
  a failure.
- **Model-assisted patching cost.** Mitigate: strategy chain tries deterministic
  methods first; per-repo budget; model mode is opt-in.
- **Upstream churn in strategy maintenance.** Mitigate: strategies are data
  (versioned YAML/TS modules), community-contributable, with the corpus feeding
  them automatically.

## Build & test

Zero runtime dependencies - Node >= 20 only. No `npm install`, no lockfile.

```bash
# run from the dep-doctor directory
node src/cli.js --help
node src/cli.js run --outdated dep-doctor.outdated.json --test-cmd "node --test test/"   # offline triage + research
node src/cli.js explain --root . --dep <name> --from <v1> --to <v2>                      # one upgrade's digest
node src/cli.js report report.json --format md                                           # re-render a saved report
node --test test/                                                                        # 41 tests
```

## v0 status

v0 is the **triage-and-research engine** - it decides what an upgrade costs
and why, before anyone (human or bot) touches code. The patch-generation half
is the documented v1 story, not a silent gap.

**Shipped, covered by 41 passing tests:**

- **Run pipeline**: plan (offline `npm outdated --json` snapshot by default;
  `--registry` opt-in) -> baseline (resolve and record the test oracle) ->
  attempts (budgeted per dep: `--attempts`, `--minutes`) -> research -> report
- **Attempt runner**: temp-copy apply by default - the target root is never
  written to; every internal write goes to a temp dir and is reported through
  `onWrite` for auditing; `--live` switches to a git worktree
- **ResearchDigest**: changelog-range extraction between the exact versions
  plus usage-site grep, so every report line cites what it saw
- **Classification**: major/minor/patch/prerelease with an honest
  `needs-human` default; `--include`/`--exclude` rules; JSON config
  (`dep-doctor.config.json`)
- **Reports**: terminal, `--json`, `--format md`; `report` re-renders a saved
  file and exits with its recorded exit code
- **Tests**: semver math, outdated-snapshot parsing, classification rules,
  digest scanning, budget enforcement with honest partial results, safety
  rails, report formats, exit codes

**Deferred (v1+, documented, not silently dropped):** the patch/strategy
chain itself (the "finishes the job" half), model-assisted edits, PR creation,
grouped-major detection, and live-registry hardening.
