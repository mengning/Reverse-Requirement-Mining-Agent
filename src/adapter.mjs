import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {runOfficialPipeline} from '../mining/official-run.mjs';
import {createHandler, validateRuntimeScope} from './handle-event.mjs';
import {configurePinnedStdinBackend, configurePodBackend, smokeConfiguredPod} from '../mining/pod/sd-pod-agent.mjs';
import * as publisher from '../mining/src/publish.mjs';

export function createAdapter(options) {
  return createHandler(options);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv[2] === '--pod-smoke') {
    console.log(JSON.stringify(await smokeConfiguredPod(process.env)));
    process.exit(0);
  }
  const env = podAgentEnvironment(process.env);
  validateRuntimeScope(env);
  const runtime = env.DEVSTAR_AGENT_RUNTIME_PATH
    ? pathToFileURL(path.resolve(env.DEVSTAR_AGENT_RUNTIME_PATH, 'src') + path.sep)
    : new URL('../.devstar/agent-runtime/src/', import.meta.url);
  const {runDevstarAgent} = await import(new URL('index.mjs', runtime));
  const {postRuntimeResult: postResult} = await import(new URL('autonomous-task.mjs', runtime));
  const {NATIVE_RESULTS_FEATURE} = await import(new URL('native-result.mjs', runtime));
  if (NATIVE_RESULTS_FEATURE !== 'native-results/v1')
    throw new Error('A shared Agent Runtime with native-results/v1 is required');
  const {tasks} = JSON.parse(await readFile(new URL('../mining/tasks/official-catalog.json', import.meta.url), 'utf8'));
  const officialCatalog = tasks.map(task => task.instance_id);
  if (env.MINING_OFFICIAL_INSTANCE && !officialCatalog.includes(env.MINING_OFFICIAL_INSTANCE)) {
    throw Error('Pinned instance is not in the official ProgramBench catalogue');
  }
  const backend = env.MINING_EXECUTION_BACKEND === 'sd-pod'
    ? await configurePodBackend(env, publisher)
    : env.MINING_EXECUTION_BACKEND === 'pinned-stdin-pod' ? await configurePinnedStdinBackend(env, publisher)
      : {catalog: env.MINING_OFFICIAL_INSTANCE ? [env.MINING_OFFICIAL_INSTANCE] : officialCatalog, pipeline: runOfficialPipeline};
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    // Older template Runtime versions do not stop the polling loop on abort.
    setTimeout(() => process.exit(1), 45000).unref();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  await runDevstarAgent({signal: controller.signal, handleEvent: createAdapter({
    ...backend, postResult, signal: controller.signal,
  })}, env);
}

function podAgentEnvironment(env) {
  if (!env.MINING_EXECUTION_BACKEND || env.MINING_EXECUTION_BACKEND === 'docker') return env;
  if (!['sd-pod', 'pinned-stdin-pod'].includes(env.MINING_EXECUTION_BACKEND)) throw Error('Unknown mining execution backend');
  const {WORK_REPO_ID, WORK_REPO_OWNER, WORK_REPO_NAME} = env;
  if (!/^[1-9]\d*$/.test(WORK_REPO_ID || '') || !/^[\w.-]+$/.test(WORK_REPO_OWNER || '') ||
      !/^[\w.-]+$/.test(WORK_REPO_NAME || '')) throw Error('Pod backend requires a bound DevStar workspace');
  const repository = `${WORK_REPO_OWNER}/${WORK_REPO_NAME}`;
  if ((env.DEVSTAR_AGENT_SCOPE_KIND && env.DEVSTAR_AGENT_SCOPE_KIND !== 'repository') ||
      (env.DEVSTAR_AGENT_SCOPE_REPO_ID && env.DEVSTAR_AGENT_SCOPE_REPO_ID !== WORK_REPO_ID) ||
      (env.MINING_AGENT_REPOSITORY && env.MINING_AGENT_REPOSITORY !== repository)) throw Error('Pod workspace scope mismatch');
  return {...env, DEVSTAR_AGENT_SCOPE_KIND: 'repository', DEVSTAR_AGENT_SCOPE_REPO_ID: WORK_REPO_ID,
    MINING_AGENT_REPOSITORY: repository, OPENJIUWEN_API_BASE: env.OPENJIUWEN_API_BASE || env.LLM_BASE_URL,
    OPENJIUWEN_API_KEY: env.OPENJIUWEN_API_KEY || env.LLM_API_KEY, OPENJIUWEN_MODEL: env.OPENJIUWEN_MODEL || env.LLM_MODEL};
}
