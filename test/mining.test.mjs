import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {runOfficialPipeline} from '../mining/official-run.mjs';
import {runDevstarAgentOnce} from '../.devstar/agent-runtime/src/index.mjs';
import {createHandler, validateRuntimeScope} from '../src/handle-event.mjs';
import {createAdapter} from '../src/adapter.mjs';

const instance = 'chmln__sd.87d1ba5';
const repository = 'owner/mining-lab';
const origin = 'https://devstar.example';
const event = {
  event_id: 19, repository: {id: 12, full_name: repository},
  body: {command: `/mine ${instance}`},
  credentials: {service_account: {token: 'test-service-account-token'}},
};
const env = {
  SELF_URL: origin, DEVSTAR_AGENT_SCOPE_KIND: 'repository', DEVSTAR_AGENT_SCOPE_REPO_ID: '12',
  MINING_AGENT_REPOSITORY: repository, DEVSTAR_TOKEN: 'instance-token-not-for-mining',
  GITHUB_TOKEN: 'unrelated-token', OPENJIUWEN_MODEL: 'fixture-model',
};

test('Agent Team workspace must agree with the platform scope and any explicit repository', () => {
  const workspace = {...env, MINING_AGENT_REPOSITORY: '', WORK_REPO_OWNER: 'owner',
    WORK_REPO_NAME: 'mining-lab', WORK_REPO_ID: '12'};
  assert.deepEqual(validateRuntimeScope(workspace), {repository, repoID: '12'});
  assert.throws(() => validateRuntimeScope({...workspace, WORK_REPO_ID: '13'}), /does not match/);
  assert.throws(() => validateRuntimeScope({...workspace, MINING_AGENT_REPOSITORY: 'other/repo'}), /does not match/);
  assert.throws(() => validateRuntimeScope({...workspace, DEVSTAR_AGENT_SCOPE_KIND: 'owner'}), /explicit repository scope/);
});

test('standard event invokes the real publisher once and reuses the receipt on replay', async t => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'requirements-agent-'));
  t.after(() => rm(state, {recursive: true, force: true}));
  let explorations = 0;
  let publications = 0;
  const issueURL = `${origin}/${repository}/issues/7`;
  const handle = createHandler({catalog: [instance], pipeline: (id, output, repo, options) => runOfficialPipeline(id, output, repo, {
    ...options,
    run: async (input, directory, childEnv) => {
      assert.equal(input, instance);
      assert.equal(childEnv.GITHUB_TOKEN, undefined);
      assert.equal(childEnv.OPENJIUWEN_MODEL, 'fixture-model');
      await mkdir(directory);
      await writeFile(path.join(directory, 'issue.json'), JSON.stringify({title: 'Candidate requirement', body: 'Observed input/output'}));
      explorations += 1;
    },
    request: async (url, request) => {
      assert.equal(request.headers.Authorization, 'token test-service-account-token');
      const base = `${origin}/api/v1/repos/${repository}`;
      if (url === base) return Response.json({full_name: repository, has_issues: true});
      assert.equal(url, base + '/issues');
      assert.equal(request.method, 'POST');
      publications += 1;
      return Response.json({...JSON.parse(request.body), number: 7, html_url: issueURL}, {status: 201});
    },
  })});
  const options = {...env, MINING_AGENT_STATE_DIR: state};
  const result = await handle(event, options);
  assert.deepEqual(result.result, {issue_number: 7, issue_url: issueURL});
  assert.deepEqual(await handle(event, options), result);
  assert.deepEqual({explorations, publications}, {explorations: 1, publications: 1});
});

test('invalid or ambiguous requests never invoke mining', async () => {
  const handle = createHandler({catalog: [instance], pipeline: () => assert.fail('pipeline must not run')});
  for (const command of ['/mine', `/mine ${instance} extra`, '/mine another__program.0000000', '/mine https://example.com/repo']) {
    assert.equal((await handle({...event, body: {command}}, env)).status, 'input_required');
  }
  await assert.rejects(() => handle({...event, repository: {id: 12, full_name: 'elsewhere/repo'}}, env), /bound repository/);
  await assert.rejects(() => handle({...event, repository: {...event.repository, id: 13}}, env), /bound repository/);
  await assert.rejects(() => handle({...event, credentials: {}}, env), /credential/);
});

test('a pre-publication failure preserves diagnostics and permits one successful replay', async t => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'requirements-agent-retry-'));
  t.after(() => rm(state, {recursive: true, force: true}));
  const output = path.join(state, '19');
  let explorations = 0;
  let publications = 0;
  const options = {
    recoverIncomplete: true,
    env: {DEVSTAR_URL: origin, GITHUB_SERVER_URL: origin, DEVSTAR_TOKEN: 'test-service-account-token'},
    request: async (_url, request) => {
      if (request.method !== 'POST') return Response.json({full_name: repository, has_issues: true});
      publications++;
      return Response.json({...JSON.parse(request.body), number: 7}, {status: 201});
    },
    run: async (_instance, directory) => {
      await mkdir(directory);
      if (++explorations === 1) {
        await writeFile(path.join(directory, 'diagnostic.txt'), 'runner stopped before publishing');
        throw new Error('runner stopped');
      }
      await writeFile(path.join(directory, 'issue.json'), JSON.stringify({title: 'Candidate', body: 'Evidence'}));
    },
  };
  const attempt = () => runOfficialPipeline(instance, output, repository, options);
  await assert.rejects(attempt(), /runner stopped/);
  assert.equal(publications, 0);
  const receipt = await attempt();
  assert.equal(receipt.number, 7);
  assert.deepEqual(await attempt(), receipt);
  const archives = (await readdir(state)).filter(name => name.startsWith('19.incomplete-'));
  assert.equal(archives.length, 1);
  assert.equal(await readFile(path.join(state, archives[0], 'diagnostic.txt'), 'utf8'), 'runner stopped before publishing');
  assert.deepEqual({explorations, publications}, {explorations: 2, publications: 1});
});

test('an existing publication receipt without a manifest prevents both rerunning and posting', async t => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'requirements-agent-uncertain-'));
  t.after(() => rm(state, {recursive: true, force: true}));
  const output = path.join(state, '19');
  await mkdir(output);
  const receipt = path.join(output, 'publication.json');
  await writeFile(receipt, '{"status":"submitting"}');
  await assert.rejects(runOfficialPipeline(instance, output, repository, {
    recoverIncomplete: true,
    env: {DEVSTAR_URL: origin, GITHUB_SERVER_URL: origin, DEVSTAR_TOKEN: 'test-service-account-token'},
    request: async (_url, request) => {
      assert.notEqual(request.method, 'POST');
      return Response.json({full_name: repository, has_issues: true});
    },
    run: () => assert.fail('pipeline must not run while publication is uncertain'),
  }), /发布回执存在/);
  assert.equal(await readFile(receipt, 'utf8'), '{"status":"submitting"}');
  assert.deepEqual(await readdir(state), ['19']);
});

test('standalone use does not move an existing output directory', async t => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'requirements-agent-existing-'));
  t.after(() => rm(state, {recursive: true, force: true}));
  const output = path.join(state, 'user-files');
  await mkdir(output);
  await writeFile(path.join(output, 'original.txt'), 'keep');
  await assert.rejects(runOfficialPipeline(instance, output, repository, {
    env: {DEVSTAR_URL: origin, GITHUB_SERVER_URL: origin, DEVSTAR_TOKEN: 'test-service-account-token'},
    request: async () => Response.json({full_name: repository, has_issues: true}),
    run: async (_instance, directory) => mkdir(directory),
  }), {code: 'EEXIST'});
  assert.deepEqual(await readdir(state), ['user-files']);
  assert.equal(await readFile(path.join(output, 'original.txt'), 'utf8'), 'keep');
});

test('a lost issue creation response stops replay without rerunning the model or posting again', async t => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'requirements-agent-lost-response-'));
  t.after(() => rm(state, {recursive: true, force: true}));
  const output = path.join(state, '19');
  let explorations = 0;
  let publications = 0;
  const options = {
    recoverIncomplete: true,
    env: {DEVSTAR_URL: origin, GITHUB_SERVER_URL: origin, DEVSTAR_TOKEN: 'test-service-account-token'},
    request: async (_url, request) => {
      if (request.method !== 'POST') return Response.json({full_name: repository, has_issues: true});
      publications++;
      throw new Error('connection closed after submitting');
    },
    run: async (_instance, directory) => {
      explorations++;
      await mkdir(directory);
      await writeFile(path.join(directory, 'issue.json'), JSON.stringify({title: 'Candidate', body: 'Evidence'}));
    },
  };
  const attempt = () => runOfficialPipeline(instance, output, repository, options);
  await assert.rejects(attempt(), /connection closed after submitting/);
  await assert.rejects(attempt(), /Submission outcome is uncertain/);
  assert.deepEqual({explorations, publications}, {explorations: 1, publications: 1});
});

test('native Agent Team delivery links the new issue from the source comment and acknowledges the event', async t => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'requirements-agent-native-'));
  t.after(() => rm(state, {recursive: true, force: true}));
  const taskID = 'lab-mining-test-19';
  const issueURL = `${origin}/${repository}/issues/7`;
  const delivered = {...event, delivery_id: taskID, body: {...event.body, issue: {number: 2},
    runtime_task: {version: 'agent-events/v1', phase: 'native', task_id: taskID, context_sha256: 'fixture',
      repository: {base_revision: 'a'.repeat(40)}}}};
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const route = new URL(url).pathname;
    const payload = options.body ? JSON.parse(options.body) : null;
    requests.push([options.method, route]);
    if (route.endsWith('/register')) {
      assert.deepEqual(payload.scope, {kind: 'repository', repo_id: 12});
      return Response.json({runtime_protocol: 'agent-events/v1'});
    }
    if (route.endsWith('/next-event')) return Response.json(delivered);
    if (route.endsWith('/issues/2/comments') && options.method === 'POST') {
      assert.ok(payload.body.includes(issueURL));
      return Response.json({id: 92}, {status: 201});
    }
    if (route.endsWith('/19/ack')) {
      assert.ok(payload.summary.includes(issueURL));
      if (payload.result?.version === 'agent-events/v1') {
        assert.equal(payload.result.result_comment_id, 92);
        assert.equal(payload.result.status, 'completed');
        assert.equal(payload.result.data.issue_number, 7);
      } else {
        assert.equal(payload.result.issue_number, 7);
      }
      return new Response(null, {status: 204});
    }
    assert.fail(`Unexpected request: ${route}`);
  });
  await runDevstarAgentOnce({
    handleEvent: createAdapter({catalog: [instance], pipeline: async () => ({number: 7, issue_url: issueURL})}),
  }, {...env, GITHUB_TOKEN: '', MINING_AGENT_STATE_DIR: state, DEVSTAR_RUNTIME_STATE_DIR: state});
  assert.deepEqual(requests.map(([method]) => method), ['POST', 'GET', 'POST', 'POST']);
});
