import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {discover} from './src/discover.mjs';
import {modelPlanner} from './src/planner.mjs';
import {renderRequirementIssue} from './src/render.mjs';
import {synthesize} from './src/synthesize.mjs';
import {createSdPodCollector, createSdPodExecutor, createStdinPodCollector, createStdinPodExecutor, readSdPodDocuments} from './src/sd-pod-execution.mjs';
import {hash, selectTask} from './src/collect.mjs';
import {validateProbe} from './src/task.mjs';
import {safeIssuePayload, withMiningSource} from '../src/publish.mjs';

const smokeInputs = [
  [{id: 'smoke-literal', argv: ['-F', 'a.b', 'OK'], stdin: 'a.b a.b axb'}, 'OK OK axb'],
  [{id: 'smoke-overlap', argv: ['-F', 'aa', 'X'], stdin: 'aaaaa'}, 'XXa'],
];

const podOptions = env => ({endpoint: env.MINING_SD_POD_URL, token: env.MINING_SD_POD_TOKEN});

export async function smoke(options) {
  const run = createSdPodExecutor(options);
  const evidence = [];
  for (const [input, expected] of smokeInputs) {
    const observed = await run(input);
    if (observed.stdout !== expected || observed.stderr !== '' || observed.exit_code !== 0) {
      throw Error('Official sd Pod smoke check did not match the expected behavior');
    }
    evidence.push(observed);
  }
  return evidence;
}

export function keepDocumentLinkedProbes(proposal) {
  if (!Array.isArray(proposal?.features) || proposal.features.length > 12 || !Array.isArray(proposal.probes) ||
      proposal.probes.length > 25 || !Array.isArray(proposal.gaps) || proposal.gaps.length > 12 ||
      proposal.features.some(f => !Array.isArray(f?.probe_ids) || f.probe_ids.length > 16 || f.probe_ids.some(id => typeof id !== 'string')) ||
      proposal.probes.some(p => typeof p?.id !== 'string') ||
      new Set(proposal.probes.map(p => p.id)).size !== proposal.probes.length) return proposal;
  const declared = new Set(proposal.probes.map(p => p.id));
  const linked = new Set(proposal.features.flatMap(f => f.probe_ids));
  const ignored = proposal.probes.filter(p => !linked.has(p.id));
  const missing = [...linked].filter(id => !declared.has(id));
  if (!ignored.length && !missing.length) return proposal;
  const note = `未执行或引用了不存在编号的探测已排除（未关联 ${ignored.length}，不存在 ${missing.length}），不能作为实测证据。`;
  const gaps = proposal.gaps.length === 12 ? proposal.gaps.map((gap, i) => i === 11 && typeof gap === 'string' &&
    gap.length <= 500 ? `${note} ${gap}`.slice(0, 500) : gap) : [...proposal.gaps, note];
  return {...proposal, gaps, probes: proposal.probes.filter(p => linked.has(p.id)),
    features: proposal.features.map(f => ({...f, probe_ids: f.probe_ids.filter(id => declared.has(id))}))};
}

function verifyFixedObservations(fixedProbes, observations) {
  if (observations.length !== fixedProbes.length || !fixedProbes.every((fixed, i) => {
    const actual = observations[i];
    return actual?.id === fixed.id && JSON.stringify(actual.argv) === JSON.stringify(fixed.argv) && actual.stdin === fixed.stdin;
  })) throw Error('Fixed probes did not execute with the exact requested arguments and input');
}

export function createPodPipeline({task, probe, runSmoke = smoke, plannerFactory = modelPlanner, publisher,
  readDocuments = readSdPodDocuments, createExecutor = createSdPodExecutor, createCollector = createSdPodCollector}) {
  const snapshot = readDocuments({...task, exploration: {max_rounds: 1, max_probes_per_round: 5}});
  return async (instance, state, repository, {env, signal, fixedProbes = [], reportOnly = false, sourceIssue} = {}) => {
    if (instance !== snapshot.task.task_id || signal?.aborted) throw Error('Unexpected or canceled mining task');
    if (fixedProbes.length > 5) throw Error('Fixed probe budget exceeded');
    for (const fixed of fixedProbes) validateProbe(fixed, snapshot.task);
    await mkdir(state, {recursive: true, mode: 0o700});
    const config = publisher.publicationConfig(repository, env);
    const issueFile = path.join(state, 'issue.json');
    const receiptFile = path.join(state, 'publication.json');
    let issue;
    try { issue = JSON.parse(await readFile(issueFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (issue) {
      if (fixedProbes.length) {
        const existing = JSON.parse(await readFile(path.join(state, 'evidence.json'), 'utf8'));
        verifyFixedObservations(fixedProbes, existing.observations);
      }
      if (reportOnly) return {reportBody: safeIssuePayload(issue, config).body};
      await readFile(receiptFile);
      return publisher.publishIssue(withMiningSource(issue, config, sourceIssue), config, receiptFile);
    }
    await publisher.checkRepository(config);
    const preflight = await runSmoke(probe);
    // Never repeat paid work for the same event without an operator reconciling it.
    await writeFile(path.join(state, 'preflight.json'), JSON.stringify(preflight), {flag: 'wx', mode: 0o600});
    const planner = plannerFactory({...env, MINING_MODEL_MAX_TOKENS: '4096', MINING_TOTAL_TOKEN_BUDGET: '18000'}, fetch, {diagnosticDir: state});
    let proposalCount = 0;
    let input;
    if (fixedProbes.length) {
      const execute = createExecutor(probe);
      const observations = [];
      for (const fixed of fixedProbes) observations.push(await execute(fixed, {signal}));
      verifyFixedObservations(fixedProbes, observations);
      input = {
        task_id: snapshot.task.task_id, scope: snapshot.task.scope, interaction: {profile: snapshot.task.profile},
        documents: snapshot.documents, observations, feature_origin: 'explicit-probes',
        features: [{id: 'F-user-probes', description: '工单明确指定的探测，用例本身不是普遍规则。',
          document_ids: [], observation_ids: observations.map(o => o.id)}],
        unexplored: ['仅执行工单明确指定的输入，其他输入及行为未探测。'],
      };
    } else {
      ({input} = await discover({...snapshot, execute: createCollector(probe), checkpointFile: null,
        planner: async (messages, options) => {
          const proposal = await planner(messages, options);
          await writeFile(path.join(state, `discovery-proposal-${++proposalCount}.json`), JSON.stringify(proposal), {flag: 'wx', mode: 0o600});
          return keepDocumentLinkedProbes(proposal);
        }}));
    }
    if (!input.observations.length || (!fixedProbes.length && !input.observations.some(observation => observation.exit_code === 0 && !observation.repeat_result))) {
      throw Error('No stable successful probe was returned; no issue published');
    }
    input.synthesis = await synthesize(input, planner, {correctOnce: false});
    if (signal?.aborted) throw Error('Mining task was canceled before publication');
    issue = renderRequirementIssue(input);
    await writeFile(path.join(state, 'evidence.json'), JSON.stringify(input), {flag: 'wx', mode: 0o600});
    await writeFile(issueFile, JSON.stringify(issue), {flag: 'wx', mode: 0o600});
    if (reportOnly) return {reportBody: safeIssuePayload(issue, config).body};
    return publisher.publishIssue(withMiningSource(issue, config, sourceIssue), config, receiptFile);
  };
}

export async function configurePodBackend(env, publisher) {
  if (!path.isAbsolute(env.MINING_SD_POD_TASK || '')) throw Error('Expected an absolute public task manifest path');
  const task = JSON.parse(await readFile(env.MINING_SD_POD_TASK, 'utf8'));
  const probe = podOptions(env);
  createSdPodExecutor(probe);
  return {catalog: [task.task_id], supportsFixedProbes: true, pipeline: createPodPipeline({task, probe, publisher})};
}

export const smokeConfiguredPod = env => smoke(podOptions(env));

function readPinnedStdinDocuments(raw) {
  const task = selectTask(raw);
  if (task.profile !== 'cli-stdin/v1' || !task.argument_policy.allowed_vectors?.length || task.resources?.length ||
      task.argument_policy.readonly_paths?.length || task.documents.some(doc => !doc.text)) {
    throw Error('Pinned Pod mode requires inline public documents and explicit stdin argument vectors');
  }
  return {task, documents: task.documents.map(({id, text}) => ({id, text, sha256: hash(text)})), records: []};
}

export function createPinnedStdinBackend({task, probe, binarySha256, smokeCase, publisher}) {
  const {task: validated} = readPinnedStdinDocuments(task);
  const createExecutor = options => createStdinPodExecutor({...options, binarySha256, validate(input) {
    validateProbe(input, validated);
  }});
  const execute = createExecutor(probe);
  validateProbe(smokeCase, validated);
  const runSmoke = async () => {
    const observed = await execute(smokeCase);
    if (observed.stdout !== smokeCase.stdout || observed.stderr !== '' || observed.exit_code !== 0) {
      throw Error('Pinned stdin probe preflight did not match');
    }
    return [observed];
  };
  return {catalog: [validated.task_id], supportsFixedProbes: true, pipeline: createPodPipeline({task, probe, publisher,
    readDocuments: readPinnedStdinDocuments, createExecutor, runSmoke,
    createCollector: options => createStdinPodCollector(createExecutor(options), readPinnedStdinDocuments,
      '实测只覆盖清单指定的程序版本、固定参数和所列标准输入；未测试输入不计为已验证。')})};
}

export async function configurePinnedStdinBackend(env, publisher) {
  if (!path.isAbsolute(env.MINING_STDIN_TASK || '')) throw Error('Expected an absolute public task manifest path');
  return createPinnedStdinBackend({task: JSON.parse(await readFile(env.MINING_STDIN_TASK, 'utf8')),
    probe: {endpoint: env.MINING_STDIN_PROBE_URL, token: env.MINING_STDIN_PROBE_TOKEN},
    binarySha256: env.MINING_STDIN_BINARY_SHA256, smokeCase: JSON.parse(env.MINING_STDIN_SMOKE), publisher});
}
