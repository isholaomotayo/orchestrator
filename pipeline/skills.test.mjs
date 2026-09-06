import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipelinePaths } from './state.mjs';
import {
  normalizeSkillsConfig, resolveSkillDir, hashSkillTree, writePin, verifySkill,
  resolveSkills, skillStatuses, renderSkillsPromptSection, skillToolAllowances,
  extractDiagramSpecs, stripDiagramSpecs, renderDiagrams,
} from './skills.mjs';

function tmpSkill({ name = 'archify' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  const skillDir = path.join(root, 'pkg');
  fs.mkdirSync(path.join(skillDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
    '---', 'name: archify', 'version: "2.16"', '---', '',
    '# Archify', '', 'Draw a diagram from a typed specification.', '',
    '## Update awareness', '', 'Run the update checker over the network.', '',
    '## Delivery', '', 'Use deliver for final acceptance.', '',
  ].join('\n'));
  fs.writeFileSync(path.join(skillDir, 'bin', 'archify.mjs'), 'console.log("{}")\n');
  const paths = pipelinePaths(root);
  const skill = normalizeSkillsConfig([{
    name, source: { type: 'local', path: skillDir }, stages: ['reporter'],
    omitSections: ['## Update awareness'],
    tools: [{ bash: 'node {skillDir}/bin/archify.mjs validate' }],
    diagrams: {
      render: 'node {skillDir}/bin/archify.mjs deliver {type} {spec} {out} --json',
      validate: 'node {skillDir}/bin/archify.mjs validate {type} {spec} --json',
      types: ['architecture', 'workflow'],
      repoRootFlag: { architecture: '--repo-root {repoRoot}' },
    },
  }])[0];
  return { root, skillDir, paths, skill, config: { skills: [skill] } };
}

// ---- config validation -----------------------------------------------------

test('a skill entry with a bad name or source is dropped rather than trusted', () => {
  const cfg = normalizeSkillsConfig([
    { name: 'Bad Name', source: { type: 'local', path: '/x' } },
    { name: 'nopath', source: { type: 'local' } },
    { name: 'noref', source: { type: 'git', repo: 'https://example.test/x.git' } },
    { name: 'weird', source: { type: 'ftp', path: '/x' } },
    { name: 'good', source: { type: 'local', path: '/x' }, stages: ['reporter'] },
  ]);
  assert.deepEqual(cfg.map((c) => c.name), ['good']);
});

test('a non-array skills block yields no skills', () => {
  assert.deepEqual(normalizeSkillsConfig(undefined), []);
  assert.deepEqual(normalizeSkillsConfig({ name: 'x' }), []);
});

// ---- pin and verify --------------------------------------------------------

test('a freshly pinned skill verifies', () => {
  const { root, skillDir, paths, skill } = tmpSkill();
  writePin(paths, skill, skillDir);
  const res = verifySkill(skill, { repoRoot: root, paths });
  assert.equal(res.ok, true);
  assert.equal(res.reason, 'verified');
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unpinned skill is refused and says how to pin it', () => {
  const { root, paths, skill } = tmpSkill();
  const res = verifySkill(skill, { repoRoot: root, paths });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unpinned');
  assert.match(res.detail, /pin archify/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a single changed byte fails verification', () => {
  const { root, skillDir, paths, skill } = tmpSkill();
  writePin(paths, skill, skillDir);
  fs.appendFileSync(path.join(skillDir, 'SKILL.md'), ' ');
  const res = verifySkill(skill, { repoRoot: root, paths });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'mismatch');
  fs.rmSync(root, { recursive: true, force: true });
});

test('an added file fails verification too', () => {
  const { root, skillDir, paths, skill } = tmpSkill();
  writePin(paths, skill, skillDir);
  fs.writeFileSync(path.join(skillDir, 'extra.mjs'), 'surprise\n');
  const res = verifySkill(skill, { repoRoot: root, paths });
  assert.equal(res.ok, false);
  assert.match(res.detail, /unexpected/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a removed file fails verification', () => {
  const { root, skillDir, paths, skill } = tmpSkill();
  writePin(paths, skill, skillDir);
  fs.unlinkSync(path.join(skillDir, 'bin', 'archify.mjs'));
  assert.equal(verifySkill(skill, { repoRoot: root, paths }).ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a missing skill directory is reported, not thrown', () => {
  const { root, paths, skill } = tmpSkill();
  const moved = { ...skill, source: { type: 'local', path: path.join(root, 'nowhere') } };
  assert.equal(verifySkill(moved, { repoRoot: root, paths }).reason, 'missing_dir');
  fs.rmSync(root, { recursive: true, force: true });
});

test('an oversized entry file is refused', () => {
  const { root, skillDir, paths, skill } = tmpSkill();
  const small = { ...skill, maxPromptBytes: 10 };
  writePin(paths, small, skillDir);
  assert.equal(verifySkill(small, { repoRoot: root, paths }).reason, 'too_large');
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveSkills only attaches verified skills for the requested stage', () => {
  const { root, skillDir, paths, skill, config } = tmpSkill();
  writePin(paths, skill, skillDir);
  const forReporter = resolveSkills(config, { repoRoot: root, paths, stage: 'reporter' });
  assert.equal(forReporter.active.length, 1);
  const forCoder = resolveSkills(config, { repoRoot: root, paths, stage: 'coder' });
  assert.equal(forCoder.active.length, 0, 'a skill applies only to the stages it declares');
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unverified skill is reported as rejected rather than silently attached', () => {
  const { root, paths, config } = tmpSkill();
  const res = resolveSkills(config, { repoRoot: root, paths, stage: 'reporter' });
  assert.equal(res.active.length, 0);
  assert.equal(res.rejected[0].reason, 'unpinned');
  assert.equal(skillStatuses(config, { repoRoot: root, paths })[0].status, 'unpinned');
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- prompt rendering ------------------------------------------------------

test('the prompt section carries the skill, its version and the pipeline overrides', () => {
  const { root, skillDir, paths, skill, config } = tmpSkill();
  writePin(paths, skill, skillDir);
  const { active } = resolveSkills(config, { repoRoot: root, paths, stage: 'reporter' });
  const text = renderSkillsPromptSection(active);
  assert.match(text, /AVAILABLE SKILLS/);
  assert.match(text, /archify \(v2\.16\)/);
  assert.match(text, /Draw a diagram/);
  assert.match(text, /PIPELINE OVERRIDES/);
  assert.match(text, /Do not run network, update-check/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('omitted sections are stripped so a skill cannot instruct a stage to phone home', () => {
  const { root, skillDir, paths, skill, config } = tmpSkill();
  writePin(paths, skill, skillDir);
  const { active } = resolveSkills(config, { repoRoot: root, paths, stage: 'reporter' });
  const text = renderSkillsPromptSection(active);
  assert.doesNotMatch(text, /Run the update checker/);
  assert.match(text, /Use deliver for final acceptance/, 'other sections survive');
  fs.rmSync(root, { recursive: true, force: true });
});

test('no skills means no prompt section at all', () => {
  assert.equal(renderSkillsPromptSection([]), '');
});

test('tool allowances expose only read-only subcommands, never the renderer', () => {
  const { root, skillDir, paths, skill, config } = tmpSkill();
  writePin(paths, skill, skillDir);
  const { active } = resolveSkills(config, { repoRoot: root, paths, stage: 'reporter' });
  const allow = skillToolAllowances(active, { runner: 'claude' });
  assert.equal(allow.length, 1);
  assert.match(allow[0], /^Bash\(node .*archify\.mjs validate:\*\)$/);
  for (const forbidden of ['deliver', 'preview', 'capture', 'check-update']) {
    assert.ok(!allow.join(' ').includes(forbidden), `${forbidden} must not be allowed`);
  }
  // Other runners have no allowlist mechanism, so they get none.
  assert.deepEqual(skillToolAllowances(active, { runner: 'codex' }), []);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- diagram specs ---------------------------------------------------------

const ARTIFACT = [
  '# Work Done', '', '## Summary', 'It works.', '', '## Diagrams', '',
  '```json archify:architecture id=system-map', '{ "nodes": [] }', '```', '',
  '```json archify:workflow id=flow', '{ "steps": [] }', '```', '',
].join('\n');

test('diagram specifications are extracted with their id and type', () => {
  const specs = extractDiagramSpecs(ARTIFACT, { types: ['architecture', 'workflow'] });
  assert.equal(specs.length, 2);
  assert.deepEqual(specs.map((s) => s.id), ['system-map', 'flow']);
  assert.deepEqual(specs[0].json, { nodes: [] });
});

test('a malformed, duplicated or unknown specification is recorded as an error, not thrown', () => {
  const bad = [
    '```json archify:architecture id=a', '{ not json', '```',
    '```json archify:teleport id=b', '{}', '```',
    '```json archify:workflow id=a', '{}', '```',
    '```json archify:workflow id=BAD_ID', '{}', '```',
    '```json archify:workflow id=c', '[1,2]', '```',
  ].join('\n');
  const specs = extractDiagramSpecs(bad, { types: ['architecture', 'workflow'] });
  assert.equal(specs.filter((s) => s.error).length, 5);
  assert.match(specs.find((s) => s.id === 'b').error, /unknown diagram type/);
  assert.match(specs.filter((s) => s.id === 'a')[1].error, /duplicate/);
  assert.match(specs.find((s) => s.id === 'c').error, /JSON object/);
});

test('an artifact with no diagrams yields none', () => {
  assert.deepEqual(extractDiagramSpecs('# Report\n\nNo pictures.\n'), []);
});

test('consumed specification blocks are stripped from the prose', () => {
  const stripped = stripDiagramSpecs(ARTIFACT);
  assert.doesNotMatch(stripped, /archify:/);
  assert.match(stripped, /It works\./);
});

// ---- rendering -------------------------------------------------------------

function fakeExec(behaviour) {
  const calls = [];
  return {
    calls,
    exec: (bin, args) => {
      calls.push([bin, ...args].join(' '));
      return behaviour(args);
    },
  };
}

test('a valid specification is validated then rendered, and the artifact is recorded', () => {
  const { root, skillDir, paths, skill } = tmpSkill();
  const outDir = path.join(root, 'reports');
  const { exec, calls } = fakeExec((args) => {
    const out = args.find((a) => a.endsWith('.html'));
    if (out) fs.writeFileSync(out, '<html>diagram</html>');
    return { status: 0, stdout: JSON.stringify({ artifact: { sha256: 'x' } }), stderr: '' };
  });
  const [res] = renderDiagrams(extractDiagramSpecs(ARTIFACT).slice(0, 1), { skill, dir: skillDir, outDir, repoRoot: root, exec });
  assert.equal(res.ok, true);
  assert.equal(res.htmlRel, 'system-map.html');
  assert.ok(res.sha256);
  assert.ok(calls.some((c) => c.includes('validate')), 'validation runs first');
  assert.ok(calls.some((c) => c.includes('--repo-root')), 'architecture diagrams get repository evidence');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a specification that fails validation is omitted with diagnostics, never rendered', () => {
  const { root, skillDir, paths, skill } = tmpSkill();
  const { exec, calls } = fakeExec(() => ({ status: 1, stdout: '', stderr: 'composition error: overlapping nodes' }));
  const [res] = renderDiagrams(extractDiagramSpecs(ARTIFACT).slice(0, 1), { skill, dir: skillDir, outDir: path.join(root, 'r'), repoRoot: root, exec });
  assert.equal(res.ok, false);
  assert.match(res.error, /validation/);
  assert.match(res.diagnostics, /overlapping nodes/);
  assert.ok(!calls.some((c) => c.includes('deliver')), 'a failed specification is never rendered');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a renderer that exits cleanly without producing a file is still a failure', () => {
  const { root, skillDir, skill } = tmpSkill();
  const { exec } = fakeExec(() => ({ status: 0, stdout: '{}', stderr: '' }));
  const [res] = renderDiagrams(extractDiagramSpecs(ARTIFACT).slice(0, 1), { skill, dir: skillDir, outDir: path.join(root, 'r'), repoRoot: root, exec });
  assert.equal(res.ok, false);
  assert.match(res.error, /render/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a renderer that crashes degrades to a note rather than failing the run', () => {
  const { root, skillDir, skill } = tmpSkill();
  const { exec } = fakeExec(() => { throw new Error('renderer exploded'); });
  const [res] = renderDiagrams(extractDiagramSpecs(ARTIFACT).slice(0, 1), { skill, dir: skillDir, outDir: path.join(root, 'r'), repoRoot: root, exec });
  assert.equal(res.ok, false);
  assert.match(res.error, /renderer exploded/);
  // A skill with no renderer declared degrades rather than crashing.
  const none = renderDiagrams(extractDiagramSpecs(ARTIFACT), { skill: { ...skill, diagrams: null }, dir: skillDir, outDir: path.join(root, 'r2'), repoRoot: root });
  assert.equal(none.every((r) => r.ok === false), true);
  fs.rmSync(root, { recursive: true, force: true });
});
