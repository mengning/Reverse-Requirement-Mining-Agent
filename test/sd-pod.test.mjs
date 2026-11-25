import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createSdPodExecutor, SD_BINARY_SHA256} from '../mining/pod/src/sd-pod-execution.mjs';
import {createPodPipeline, keepDocumentLinkedProbes, smoke} from '../mining/pod/sd-pod-agent.mjs';
import {readFixedProbes} from '../src/fixed-probes.mjs';

const endpoint = 'http://10.0.0.8:30000/v1/probe';
const token = 'a'.repeat(48);

test('smoke runs both probes and rejects changed evidence before mining', async () => {
  const request = async (_url, options) => {
    assert.equal(options.redirect, 'error');
    const input = JSON.parse(options.body);
    return Response.json({...input, sha256: SD_BINARY_SHA256, networkBlocked: true, uid: 1000,
      stdout: input.id === 'smoke-literal' ? 'OK OK axb' : 'XXa', stderr: '', exitCode: 0});
  };
  const results = await smoke({endpoint, token, request});
  assert.deepEqual(results.map(r => [r.stdout, r.stderr, r.exit_code]), [['OK OK axb', '', 0], ['XXa', '', 0]]);
  const execute = createSdPodExecutor({endpoint, token, request: async () => Response.json({sha256: 'wrong'})});
  await assert.rejects(execute({id: 'test', argv: ['-F', 'x', 'y'], stdin: 'x'}), /valid evidence/);
  assert.throws(() => createSdPodExecutor({endpoint: 'https://example.com/v1/probe', token}), /private Pod/);
});

test('orphan inputs and dangling references are excluded without inventing evidence', () => {
  const kept = {id: 'OBS-linked', argv: ['-F', 'a.b', 'OK'], stdin: 'a.b axb'};
  const raw = {gaps: [], features: [{probe_ids: ['OBS-linked', 'OBS-missing']}], probes: [kept, {id: 'OBS-orphan'}]};
  const result = keepDocumentLinkedProbes(raw);
  assert.deepEqual(result.probes, [kept]);
  assert.deepEqual(result.features[0].probe_ids, ['OBS-linked']);
  assert.equal(result.gaps.length, 1);
  assert.equal(raw.probes.length, 2);
});

test('fixed JSON probes preserve empty arguments, spaces and exact newlines', () => {
  const json = [{argv: ['-F', ' a b ', ''], stdin: '  a b\r\n\n'}];
  const fenced = '```json mining-probes\n' + JSON.stringify(json) + '\n```';
  assert.deepEqual(readFixedProbes(fenced), [{id: 'OBS-fixed-1', ...json[0]}]);
  assert.throws(() => readFixedProbes('1. 参数为 `-F "a b" X`，标准输入为 `a b`。'), /未运行探测/);
  assert.throws(() => readFixedProbes('参数为 `-F a.b X`\n标准输入为 `a.b`。'), /未运行探测/);
  assert.throws(() => readFixedProbes('```mining-probes\n[]\n```'), /未运行探测/);
  assert.deepEqual(readFixedProbes('Explore the documented program.'), []);
});

test('fixed #407 probes reach the executor unchanged; synthesis cannot replace them', async t => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'fixed-mining-'));
  t.after(() => rm(state, {recursive: true, force: true}));
  const probes = readFixedProbes('1. 参数为 `-F a.b X`，标准输入为 `a.b axb a.b` 加末尾换行。\n' +
    '2. 参数为 `-F zzz Q`，标准输入为 `hello world` 加末尾换行。');
  const task = {
    task_id: 'chmln__sd.87d1ba5', image: 'programbench/chmln_1776_sd.87d1ba5@sha256:9d78a509bd5d427b634d4192524cd5fa06f63965162bbac068f3d2f2e33db666',
    executable: '/workspace/executable', scope: 'Literal matching on standard input.', profile: 'cli-stdin/v1',
    documents: [{id: 'DOC-readme', text: 'String-literal mode disables regular expressions.'}],
    argument_policy: {min_args: 3, max_args: 3, prefix: ['-F']},
  };
  const executed = [];
  let calls = 0, published = 0;
  const request = async (_url, options) => {
    const input = JSON.parse(options.body);
    executed.push(input);
    return Response.json({...input, sha256: SD_BINARY_SHA256, networkBlocked: true, uid: 1000,
      stdout: input.id === probes[0].id ? 'X axb X\n' : 'hello world\n', stderr: '', exitCode: 0});
  };
  const pipeline = createPodPipeline({
    task, probe: {endpoint, token, request}, runSmoke: async () => [],
    publisher: {publicationConfig: () => ({}), checkRepository: async () => {},
      publishIssue: async issue => {
        published++;
        assert.match(issue.body, /OBS-fixed-1/);
        assert.match(issue.body, /X axb X/);
        assert.doesNotMatch(issue.body, /Z axb Z/);
        assert.match(issue.body, /实测样例.*OBS-fixed-1.*OBS-fixed-2/);
        assert.doesNotMatch(issue.body, /Every input is always replaced|All matches were replaced/);
        return {number: 408};
      }},
    plannerFactory: () => async (messages, options) => {
      calls++;
      assert.equal(options.stage, 'synthesis');
      const input = JSON.parse(messages[1].content);
      assert.deepEqual(input.observations.map(({id, argv, stdin}) => ({id, argv, stdin})), probes);
      return {version: 'requirements-synthesis/v1',
        probes: [{id: 'OBS-fixed-1', argv: ['-F', 'a.b', 'Z'], stdin: 'altered'}],
        groups: [{id: 'G-fixed', title: 'Literal matching', feature_ids: ['F-user-probes'],
          candidate_requirement: 'Every input is always replaced.', conditions: ['Standard input'],
          document_interpretation: 'Literal matching', observation_ids: probes.map(probe => probe.id),
          observed_summary: 'All matches were replaced.', inference: 'Other inputs unverified',
          missing_checks: ['Other characters'], conflicts: []}]};
    },
  });
  await pipeline(task.task_id, state, 'owner/repo', {env: {}, fixedProbes: probes});
  assert.deepEqual(executed, probes);
  const proof = JSON.parse(await readFile(path.join(state, 'evidence.json'), 'utf8'));
  assert.deepEqual(proof.observations.map(o => o.argv), probes.map(p => p.argv));
  const report = await pipeline(task.task_id, state, 'owner/repo', {env: {}, fixedProbes: probes, reportOnly: true});
  assert.match(report.reportBody, /X axb X/);
  assert.deepEqual(executed, probes);
  assert.deepEqual({calls, published}, {calls: 1, published: 1});
});
