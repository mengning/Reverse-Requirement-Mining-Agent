import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {runOfficialPipeline} from '../mining/official-run.mjs';
import {createHandler} from '../src/handle-event.mjs';
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
  for (const command of ['/mine', `/mine ${instance} extra`, '/mine another__program.0000000',
    '/mine https://example.com/repo', '/mine programs/wordstat']) {
    assert.equal((await handle({...event, body: {command}}, env)).status, 'input_required');
  }
  await assert.rejects(() => handle({...event, repository: {id: 12, full_name: 'elsewhere/repo'}}, env), /bound repository/);
  await assert.rejects(() => handle({...event, repository: {...event.repository, id: 13}}, env), /bound repository/);
  await assert.rejects(() => handle({...event, credentials: {}}, env), /credential/);
});

test('Planner authorization accepts one catalog instance from the separate instruction', async () => {
  let calls = 0;
  const handle = createHandler({catalog: [instance], readIssue: async () => ({number: 4, body: 'Explore the program.'}), pipeline: async id => {
    assert.equal(id, instance);
    calls++;
    return {number: 7, issue_url: `${origin}/${repository}/issues/7`};
  }});
  const body = {source: 'agent_command', source_event: 'issue_comment', capability: 'requirements-mining',
    command: '/mine', issue: {number: 4}, instruction: `Explore ${instance}; use only ${instance}.`};
  const options = {...env, MINING_AGENT_STATE_DIR: os.tmpdir()};
  assert.equal((await handle({...event, body}, options)).result.issue_number, 7);
  assert.equal((await handle({...event, body: {...body, command: `/mine ${body.instruction}`}}, options)).result.issue_number, 7);
  for (const variant of [{...body, source: 'issue_comment'}, {...body, capability: 'specification-authoring'},
    {...body, instruction: `${instance} and another__program.0000000`}, {...body, instruction: 'no instance'},
    {...body, command: `/mine ${instance} unexpected`}]) {
    assert.equal((await handle({...event, body: variant}, options)).status, 'input_required');
  }
  assert.equal(calls, 2);
});

test('ProgramBench program name from the demo delegates using the catalog, not a hardcoded instance', async () => {
  const gron = 'tomnomnom__gron.88a6234';
  const alternateSD = 'other__sd.0000000';
  const calls = [];
  const handler = catalog => createAdapter({
    catalog,
    readIssue: async () => ({number: 1, body: 'Test one ProgramBench program and report here.'}),
    pipeline: async id => {
      calls.push(id);
      return {number: 7, issue_url: `${origin}/${repository}/issues/7`};
    },
  });
  const body = {source: 'agent_command', source_event: 'issue_comment', capability: 'requirements-mining',
    command: '/mine', issue: {number: 1}};
  const options = {...env, MINING_AGENT_STATE_DIR: os.tmpdir()};
  const dispatch = (catalog, instruction) => handler(catalog)({...event, body: {...body, instruction}}, options);
  const evidence = await dispatch([instance, gron], '在 ProgramBench 的 sd 实例上执行 -F 字面替换、输入来自标准输入的探测，记录实际命令、输入、输出与退出码，并将结果回贴到本工单。');
  assert.equal(evidence.result.issue_number, 7);
  assert.equal((await dispatch([instance, gron], 'Explore ProgramBench program gron. Record the output.')).result.issue_number, 7);
  const duplicate = await dispatch([instance, alternateSD, gron], '请测试 ProgramBench 的 `sd`。');
  assert.equal(duplicate.status, 'input_required');
  assert.match(duplicate.summary, /chmln__sd.*other__sd/);
  for (const text of ['请测试 ProgramBench 的 unknown，参考 sd。', '请测试 ProgramBench 的 sd 或 gron。', '请测试 ProgramBench 的 sd 和 ProgramBench 的 gron。', '这单没有指定程序。']) {
    assert.equal((await dispatch([instance, gron], text)).status, 'input_required');
  }
  assert.equal((await dispatch([instance, alternateSD], `Explore ${instance}.`)).result.issue_number, 7);
  assert.deepEqual(calls, [instance, gron, instance]);
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

test('native Agent Team delivery links exactly once before closing the mining task', async t => {
  const runtime = process.env.DEVSTAR_AGENT_RUNTIME_PATH
    ? pathToFileURL(path.resolve(process.env.DEVSTAR_AGENT_RUNTIME_PATH, 'src') + path.sep)
    : new URL('../.devstar/agent-runtime/src/', import.meta.url);
  const {runDevstarAgentOnce} = await import(new URL('index.mjs', runtime));
  const {postRuntimeResult} = await import(new URL('autonomous-task.mjs', runtime));
  const state = await mkdtemp(path.join(os.tmpdir(), 'requirements-agent-native-'));
  t.after(() => rm(state, {recursive: true, force: true}));
  const taskID = 'lab-mining-test-19';
  const source = {number: 2, title: '需求挖掘任务', state: 'open',
    body: '本工单仅用于需求挖掘。新需求工单创建后关闭本工单。'};
  const issueURL = `${origin}/${repository}/issues/7`;
  const delivered = {...event, delivery_id: taskID, body: {
    command: '/mine', instruction: '探测 ProgramBench 的 sd。', source: 'agent_command',
    source_event: 'issue_comment', capability: 'requirements-mining', issue: {number: 2},
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
    if (route.endsWith('/issues/2') && options.method === 'GET') return Response.json(source);
    if (route.endsWith('/issues/2/comments') && options.method === 'GET') return Response.json([]);
    if (route.endsWith('/issues/2/comments') && options.method === 'POST') {
      assert.ok(payload.body.includes(issueURL));
      assert.match(payload.body, /devstar-runtime-result lab-mining-test-19/);
      return Response.json({id: 92}, {status: 201});
    }
    if (route.endsWith('/issues/2') && options.method === 'PATCH') {
      assert.deepEqual(payload, {state: 'closed'});
      assert.ok(requests.some(([method, path]) => method === 'POST' && path.endsWith('/issues/2/comments')));
      return Response.json({...source, state: 'closed'});
    }
    if (route.endsWith('/19/ack')) {
      assert.ok(payload.summary.includes(issueURL));
      assert.equal(payload.result?.version, 'agent-events/v1');
      assert.equal(payload.result.result_comment_id, 92);
      assert.equal(payload.result.status, 'completed');
      assert.equal(payload.result.data.issue_number, 7);
      return new Response(null, {status: 204});
    }
    assert.fail(`Unexpected request: ${route}`);
  });
  await runDevstarAgentOnce({
    handleEvent: createAdapter({catalog: [instance], postResult: postRuntimeResult, pipeline: async (_id, _state, _repo, options) => {
      assert.equal(options.sourceIssue, 2);
      return {number: 7, issue_url: issueURL};
    }}),
  }, {...env, GITHUB_TOKEN: '', MINING_AGENT_STATE_DIR: state, DEVSTAR_RUNTIME_STATE_DIR: state});
  assert.equal(requests.filter(([method, route]) => method === 'POST' && route.endsWith('/issues/2/comments')).length, 1);
  assert.equal(requests.filter(([method, route]) => method === 'PATCH' && route.endsWith('/issues/2')).length, 1);
  assert.ok(!requests.some(([method, route]) => method === 'POST' && route.endsWith('/issues')));
});

test('the official runner refuses exact probes from the original Issue even if Planner changes them', async () => {
  const body = {
    source: 'agent_command', source_event: 'issue_comment', capability: 'requirements-mining', command: '/mine',
    issue: {number: 407}, instruction: `Explore ${instance}, replacing a.b with Z`,
  };
  const original = '1. 参数为 `-F a.b X`，标准输入为 `a.b axb a.b` 加末尾换行。\r\n' +
    '2. 参数为 `-F zzz Q`，标准输入为 `hello world` 加末尾换行。';
  let reads = 0;
  const handle = createAdapter({catalog: [instance],
    readIssue: async (_event, method, route) => {
      assert.deepEqual([method, route], ['GET', '/issues/407']);
      reads++;
      return {number: 407, body: original};
    },
    pipeline: () => assert.fail('must not replace fixed inputs with model-designed probes'),
  });
  const result = await handle({...event, body}, {...env, MINING_AGENT_STATE_DIR: os.tmpdir()});
  assert.equal(reads, 1);
  assert.equal(result.status, 'input_required');
  assert.match(result.summary, /原样执行/);
  assert.equal(result.result, undefined);
});

test('issue and ChatBot use the same publication path; only the opted-in task issue closes after a receipt', async t => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'mining-handoff-'));
  t.after(() => rm(state, {recursive: true, force: true}));
  const opts = {...env, MINING_AGENT_STATE_DIR: state};
  const trace = [];
  const raw = '用 ProgramBench 的 sd 探测 -F。\n本工单仅用于需求挖掘。新需求工单创建后关闭本工单。';
  const task = {number: 4, title: '挖掘任务', body: raw, state: 'open'};
  let issueBody = raw;
  let publications = 0;
  let failPublication = false;
  let failClose = false;
  const handle = createAdapter({catalog: [instance],
    readIssue: async (_evt, method, route, data) => {
      assert.equal(route, '/issues/4');
      trace.push(method);
      if (method === 'PATCH') {
        assert.deepEqual(data, {state: 'closed'});
        if (failClose) throw Error('write permission missing');
        return {...task, state: 'closed'};
      }
      return {...task, body: issueBody};
    },
    postResult: async (_evt, summary) => {
      assert.match(summary, /issues\/7/);
      trace.push('link');
      return {id: 21};
    },
    pipeline: (id, output, repo, options) => runOfficialPipeline(id, output, repo, {
      ...options,
      run: async (_id, dir) => {
        await mkdir(dir);
        await writeFile(path.join(dir, 'issue.json'), JSON.stringify({title: '候选需求', body: '真实证据'}));
      },
      request: async (_url, req) => {
        if (req.method !== 'POST') return Response.json({full_name: repo, has_issues: true});
        trace.push('publish');
        if (failPublication) return new Response(null, {status: 503});
        publications++;
        const payload = JSON.parse(req.body);
        if (options.sourceIssue) assert.match(payload.body, /需求挖掘任务 #4.*issues\/4/);
        else assert.equal(payload.body, '真实证据');
        return Response.json({...payload, number: options.sourceIssue ? 7 : 8}, {status: 201});
      },
    }),
  });
  const issue = {source: 'agent_command', source_event: 'issue_comment', capability: 'requirements-mining',
    command: '/mine', issue: {number: 4}, instruction: '探测 ProgramBench 的 sd。'};
  const chat = {source: 'chatbot_tool', agent_capability_id: 'requirements-mining',
    command: '/mine', chat_run_id: 'chat-run-1', issue: {number: 4}, instruction: '探测 ProgramBench 的 sd。'};
  assert.equal((await handle({...event, body: issue}, opts)).result.issue_number, 7);
  assert.deepEqual(trace.splice(0), ['GET', 'publish', 'link', 'GET', 'PATCH']);
  assert.equal((await handle({...event, event_id: 20, body: chat}, opts)).result.issue_number, 8);
  assert.deepEqual(trace.splice(0), ['publish'], 'ChatBot does not change the Issue it was opened from');
  issueBody = '普通需求讨论，不是独立挖掘任务。';
  assert.equal((await handle({...event, event_id: 21, body: issue}, opts)).result.issue_number, 7);
  assert.deepEqual(trace.splice(0), ['GET', 'publish']);
  issueBody = raw;
  failPublication = true;
  await assert.rejects(() => handle({...event, event_id: 22, body: issue}, opts), /Issue creation HTTP 503/);
  assert.deepEqual(trace.splice(0), ['GET', 'publish']);
  failPublication = false;
  failClose = true;
  assert.match((await handle({...event, event_id: 23, body: issue}, opts)).summary, /原任务未确认关闭/);
  assert.deepEqual(trace.splice(0), ['GET', 'publish', 'link', 'GET', 'PATCH']);
  assert.equal(publications, 4);
});

test('unsupported runtime will not silently fall back to model-generated arguments', async () => {
  const handle = createHandler({catalog: [instance],
    readIssue: async () => ({number: 407, body: '1. 参数为 `-F a.b X`，标准输入为 `a.b`。'}),
    pipeline: () => assert.fail('must not start a backend that cannot preserve exact arguments'),
  });
  const result = await handle({...event, body: {...event.body, issue: {number: 407}}}, env);
  assert.equal(result.status, 'input_required');
  assert.match(result.summary, /原样执行/);
});
