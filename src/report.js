/** Deterministic renderers over the frozen report schema (v1). */

export const SCHEMA_VERSION = 1;

export function summarize(results, plan) {
  const summary = { 'already-green': 0, 'will-break': 0, 'needs-human': 0, unknown: 0, skipped: 0 };
  for (const r of results) {
    if (summary[r.status] != null) summary[r.status]++;
  }
  for (const e of plan.entries) {
    if (e.status === 'skipped') summary.skipped++;
    else if (e.status === 'unknown' && !results.some((r) => r.name === e.name)) summary.unknown++;
  }
  summary.total = plan.entries.length;
  return summary;
}

export function renderJSON(report) {
  return JSON.stringify(report, null, 2);
}

function line(s = '') {
  return s;
}

function digestLines(digest, indent = '    ') {
  if (!digest) return [`${indent}(no research digest)`];
  const out = [];
  const cl = digest.changelog;
  if (cl.found) {
    out.push(`${indent}changelog: ${cl.path} — ${cl.releasesInRange} release(s) in (${digest.from}, ${digest.to}]`);
    for (const v of cl.versions) {
      for (const b of v.breaking) out.push(`${indent}  BREAKING ${v.version}: ${b}`);
      for (const d of v.deprecations) out.push(`${indent}  DEPRECATED ${v.version}: ${d}`);
      if (v.breaking.length === 0 && v.deprecations.length === 0) {
        for (const n of v.notes.slice(0, 2)) out.push(`${indent}  ${v.version}: ${n}`);
      }
    }
  } else {
    out.push(`${indent}changelog: not found for ${digest.dep} — partial digest`);
  }
  const u = digest.usage;
  if (u.sites.length) {
    out.push(`${indent}usage sites (${u.sites.length}${u.truncated ? '+ capped' : ''}):`);
    for (const s of u.sites.slice(0, 8)) out.push(`${indent}  ${s.file}:${s.line}`);
  } else {
    out.push(`${indent}usage sites: none found in scanned sources`);
  }
  return out;
}

function tail(text, n = 12) {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
  return lines.slice(-n);
}

export function renderTerminal(report) {
  const out = [];
  const b = report.baseline;
  out.push(line(`dep-doctor v${report.version} — triage report`));
  out.push(line(`root: ${report.root}`));
  if (b) {
    const mark = b.ok ? '✅ green' : '🔴 RED';
    out.push(line(`baseline: ${mark} — \`${b.testCommand}\` (${b.durationMs}ms, source: ${b.testSource}) · tree ${report.baseline.treeHash.slice(0, 12)}${report.baseline.sha ? ` · sha ${report.baseline.sha.slice(0, 12)}` : ''}`));
    if (!b.ok) {
      out.push(line('  failing output:'));
      for (const l of tail(b.output, 15)) out.push(line(`    ${l}`));
      out.push(line('  ✋ never fix on red — fix main first, then re-run dep-doctor.'));
    }
  }
  const s = report.summary;
  out.push(line(`plan: ${report.plan.entries.length} outdated · ${s.skipped} skipped/excluded · source: ${report.plan.outdatedSource}`));
  out.push(line(''));

  const byStatus = (st) => report.results.filter((r) => r.status === st);

  const green = byStatus('already-green');
  out.push(line(`✅ already-green (${green.length}) — bump applies cleanly, tests pass`));
  for (const r of green) {
    out.push(line(`  ${r.name} ${r.from} → ${r.to}  (${r.attemptsUsed} attempt${r.attemptsUsed === 1 ? '' : 's'}${r.flaky ? ', flaky' : ''})`));
  }

  const breaking = byStatus('will-break');
  out.push(line(`❌ will-break (${breaking.length}) — tests fail under the bump`));
  for (const r of breaking) {
    out.push(line(`  ${r.name} ${r.from} → ${r.to}${r.major ? ' (major)' : ''} — attempts: ${r.attemptsUsed}`));
    const lastFail = [...r.attempts].reverse().find((a) => !a.ok);
    if (lastFail) {
      out.push(line(`    failing output:`));
      for (const l of tail(lastFail.output, 8)) out.push(line(`      ${l}`));
    }
    out.push(...digestLines(r.digest));
  }

  const human = byStatus('needs-human');
  out.push(line(`⚠️  needs-human (${human.length}) — budget/policy stopped us; research brief attached`));
  for (const r of human) {
    out.push(line(`  ${r.name} ${r.from} → ${r.to}${r.major ? ' (major)' : ''} — reason: ${r.reason} · attempts: ${r.attemptsUsed}/${report.budgets.attemptsPerDep} · ${r.minutesSpent}min/${report.budgets.minutesPerDep}min`));
    if (r.observed) out.push(line(`    observed: tests ${r.observed}`));
    out.push(...digestLines(r.digest));
  }

  const unknown = report.results.filter((r) => r.status === 'unknown');
  if (unknown.length) {
    out.push(line(`❓ unknown (${unknown.length}) — no test command; cannot classify honestly`));
    for (const r of unknown) out.push(line(`  ${r.name} ${r.from} → ${r.to}`));
  }

  const skipped = report.plan.entries.filter((e) => e.status === 'skipped');
  if (skipped.length) {
    out.push(line(`⏭  skipped/excluded (${skipped.length})`));
    for (const e of skipped) out.push(line(`  ${e.name} ${e.current} → ${e.target} — ${e.reason}`));
  }

  out.push(line(''));
  out.push(line(`budget: ${report.budgets.totals.attempts} attempt(s) used total · attempts-per-dep ${report.budgets.attemptsPerDep} · minutes-per-dep ${report.budgets.minutesPerDep}`));
  if (report.notes?.length) {
    for (const n of report.notes) out.push(line(`note: ${n}`));
  }
  out.push(line(`exit ${report.exitCode} — ${exitMeaning(report.exitCode)}`));
  return out.join('\n');
}

function exitMeaning(code) {
  if (code === 0) return 'all clear';
  if (code === 1) return 'human action needed';
  if (code === 2) return 'usage error';
  if (code === 3) return 'baseline red — nothing attempted';
  return 'unknown';
}

export function renderMarkdown(report) {
  const md = [];
  const b = report.baseline;
  md.push(`## dep-doctor triage report`);
  md.push('');
  md.push(`- **Repo:** \`${report.root}\``);
  md.push(`- **Generated:** ${report.generatedAt} (deterministic clock)`);
  md.push(`- **Baseline:** ${b ? (b.ok ? `✅ green` : `🔴 red`) : 'n/a'} — \`${b ? b.testCommand : '-'}\` · tree \`${b ? b.treeHash.slice(0, 12) : '-'}\`${b?.sha ? ` · sha \`${b.sha.slice(0, 12)}\`` : ''}`);
  md.push(`- **Outdated source:** ${report.plan.outdatedSource}`);
  md.push(`- **Exit code:** ${report.exitCode} (${exitMeaning(report.exitCode)})`);
  md.push('');
  if (b && !b.ok) {
    md.push(`### ⛔ Baseline is red — nothing was attempted`);
    md.push('');
    md.push('```');
    md.push(tail(b.output, 30).join('\n'));
    md.push('```');
    md.push('');
    md.push('Fix `main` first; dep-doctor never migrates on top of a broken baseline.');
    md.push('');
  }
  const s = report.summary;
  md.push(`### Summary`);
  md.push('');
  md.push(`| already-green | will-break | needs-human | unknown | skipped |`);
  md.push(`|---:|---:|---:|---:|---:|`);
  md.push(`| ${s['already-green']} | ${s['will-break']} | ${s['needs-human']} | ${s.unknown} | ${s.skipped} |`);
  md.push('');

  const section = (title, status, describe) => {
    const rows = report.results.filter((r) => r.status === status);
    if (!rows.length) return;
    md.push(`### ${title} (${rows.length})`);
    md.push('');
    for (const r of rows) {
      md.push(describe(r));
      md.push('');
    }
  };

  section('✅ Already green', 'already-green', (r) =>
    [
      `- **${r.name}** \`${r.from}\` → \`${r.to}\` — tests pass in ${r.attemptsUsed} attempt(s). Safe to land.`,
      r.flaky ? '  - ⚠️ passed on rerun — treat as flaky.' : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  section('❌ Will break', 'will-break', (r) => {
    const lines = [`- **${r.name}** \`${r.from}\` → \`${r.to}\`${r.major ? ' (major)' : ''} — tests fail (${r.attemptsUsed} attempts).`];
    const lastFail = [...r.attempts].reverse().find((a) => !a.ok);
    if (lastFail) {
      lines.push('  - failing output:');
      lines.push('    ```');
      for (const l of tail(lastFail.output, 12)) lines.push(`    ${l}`);
      lines.push('    ```');
    }
    lines.push(...digestLines(r.digest, '  ').map((l) => `  ${l.trimStart()}`));
    return lines.join('\n');
  });

  section('⚠️ Needs human', 'needs-human', (r) => {
    const lines = [
      `- **${r.name}** \`${r.from}\` → \`${r.to}\`${r.major ? ' (major)' : ''} — ${r.reason}.`,
      `  - attempts: ${r.attemptsUsed}/${report.budgets.attemptsPerDep} · time: ${r.minutesSpent}/${report.budgets.minutesPerDep} min${r.observed ? ` · observed: tests ${r.observed}` : ''}`,
    ];
    lines.push(...digestLines(r.digest, '  ').map((l) => `  ${l.trimStart()}`));
    return lines.join('\n');
  });

  const skipped = report.plan.entries.filter((e) => e.status === 'skipped');
  if (skipped.length) {
    md.push(`### ⏭ Skipped / excluded (${skipped.length})`);
    md.push('');
    for (const e of skipped) md.push(`- \`${e.name}\` \`${e.current}\` → \`${e.target}\` — ${e.reason}`);
    md.push('');
  }

  md.push('### Budgets');
  md.push('');
  md.push(`- attempts-per-dep: ${report.budgets.attemptsPerDep} · minutes-per-dep: ${report.budgets.minutesPerDep}`);
  md.push(`- total attempts used: ${report.budgets.totals.attempts} · total minutes: ${report.budgets.totals.minutesSpent}`);
  md.push('');
  md.push(`---`);
  md.push(`opened by dep-doctor v${report.version} · PR opening deferred in v0 (see README "v0 status")`);
  return md.join('\n');
}
