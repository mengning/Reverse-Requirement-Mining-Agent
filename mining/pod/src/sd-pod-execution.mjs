import {isIPv4} from 'node:net';
import {hash, selectPlan, selectTask} from './collect.mjs';

export const SD_BINARY_SHA256 = '3958ba947c587bb2f4b22425ea2abf135cc75c67d4e8de5863c2fbbbbb56de67';
const SD_IMAGE = 'programbench/chmln_1776_sd.87d1ba5@sha256:9d78a509bd5d427b634d4192524cd5fa06f63965162bbac068f3d2f2e33db666';

function privateProbeURL(endpoint) {
  const url = new URL(endpoint);
  const [a, b] = url.hostname.split('.').map(Number);
  const privateIP = isIPv4(url.hostname) && (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
  if (!privateIP || !['http:', 'https:'].includes(url.protocol) || !url.port || url.pathname !== '/v1/probe' ||
      url.username || url.password || url.search || url.hash) throw Error('Expected a dedicated private Pod probe endpoint');
  return url.href;
}

export function createSdPodExecutor({endpoint, token, request = fetch} = {}) {
  const url = privateProbeURL(endpoint);
  if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) throw Error('Missing short-lived probe credential');
  return async function execute({id, argv, stdin}, {signal} = {}) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id) || !Array.isArray(argv) || argv.length !== 3 || argv[0] !== '-F' ||
        typeof stdin !== 'string' || Buffer.byteLength(stdin) > 1024 || !argv[1] ||
        argv.slice(1).some(arg => typeof arg !== 'string' || arg.startsWith('-') || arg.includes('\0') || Buffer.byteLength(arg) > 64)) {
      throw Error('Expected a bounded sd literal stdin probe');
    }
    const timeout = AbortSignal.timeout(8000);
    const response = await request(url, {method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: {'content-type': 'application/json', authorization: `Bearer ${token}`}, body: JSON.stringify({id, argv, stdin})});
    if (!response.ok) throw Error(`sd Pod probe failed: HTTP ${response.status}`);
    const result = await response.json();
    if (!result || result.id !== id || JSON.stringify(result.argv) !== JSON.stringify(argv) || result.stdin !== stdin ||
        result.sha256 !== SD_BINARY_SHA256 || result.uid !== 1000 || result.networkBlocked !== true ||
        !Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255 ||
        typeof result.stdout !== 'string' || typeof result.stderr !== 'string' ||
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 131072) {
      throw Error('sd Pod did not return valid evidence for the requested probe');
    }
    return {id, argv, stdin, stdout: result.stdout, stderr: result.stderr, exit_code: result.exitCode,
      executable_sha256: result.sha256, execution: 'devstar-pod', network_blocked: true, uid: result.uid};
  };
}

export function readSdPodDocuments(raw) {
  const task = selectTask(raw);
  if (task.task_id !== 'chmln__sd.87d1ba5' || task.profile !== 'cli-stdin/v1' || task.image !== SD_IMAGE ||
      task.executable !== '/workspace/executable' || task.documents.some(d => typeof d.text !== 'string' || !d.text.trim())) {
    throw Error('sd Pod mode needs the pinned official task and inline public documents');
  }
  return {task, documents: task.documents.map(({id, text}) => ({id, text, sha256: hash(text)})), records: []};
}

export function createSdPodCollector(options) {
  const execute = createSdPodExecutor(options);
  let remaining = 8;
  return async function collectFromSdPod(raw) {
    const plan = selectPlan(raw);
    const {documents} = readSdPodDocuments(plan);
    if (plan.probes.length > remaining || plan.probes.some(probe => probe.file_text !== undefined)) {
      throw Error('sd Pod mode only supports up to eight stdin probes per run');
    }
    remaining -= plan.probes.length;
    const observations = [];
    const records = [];
    for (const probe of plan.probes) {
      const first = await execute(probe);
      const second = await execute(probe);
      records.push(first, second);
      const observation = {...first, ...(JSON.stringify(first) !== JSON.stringify(second) ? {repeat_result: second} : {})};
      observations.push({...observation, sha256: hash(observation)});
    }
    const input = {task_id: plan.task_id, scope: plan.scope, documents, observations, features: plan.features,
      interaction: {profile: plan.profile}, unexplored: ['仅覆盖固定官方 sd 二进制的字面标准输入探测，未使用官方完整根文件系统。',
        ...observations.filter(o => o.repeat_result).map(o => `${o.id} 两次结果不同，不视为稳定行为。`)]};
    return {input, provenance: {plan, plan_sha256: hash(plan), input_sha256: hash(input), records,
      repeats: 2, official_answers_supplied: false, spec_candidate_supplied: false}};
  };
}
