import assert from 'node:assert/strict';
import test from 'node:test';
import {createSdPodExecutor, SD_BINARY_SHA256} from '../mining/pod/src/sd-pod-execution.mjs';
import {keepDocumentLinkedProbes, smoke} from '../mining/pod/sd-pod-agent.mjs';

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
