import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {requestRepoJSON, runDevstarAgent} from '../.devstar/agent-runtime/src/index.mjs';
import {runOfficialPipeline} from '../mining/official-run.mjs';
import {createHandler, validateRuntimeScope} from './handle-event.mjs';
import {configurePodBackend, smokeConfiguredPod} from '../mining/pod/sd-pod-agent.mjs';
import * as publisher from '../mining/src/publish.mjs';

export function createAdapter(options) {
  const handle = createHandler(options);
  return async (event, env) => {
    const result = await handle(event, env);
    const number = event.body?.issue?.number;
    if (Number.isSafeInteger(number) && number > 0 && !event.body.pull_request)
      await requestRepoJSON(event, 'POST', `/issues/${number}/comments`, {body: result.summary}, env);
    return result;
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv[2] === '--pod-smoke') {
    console.log(JSON.stringify(await smokeConfiguredPod(process.env)));
    process.exit(0);
  }
  const env = podAgentEnvironment(process.env);
  validateRuntimeScope(env);
  const {tasks} = JSON.parse(await readFile(new URL('../mining/tasks/official-catalog.json', import.meta.url), 'utf8'));
  const backend = env.MINING_EXECUTION_BACKEND === 'sd-pod'
    ? await configurePodBackend(env, publisher)
    : {catalog: tasks.map(task => task.instance_id), pipeline: runOfficialPipeline};
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    // Older template Runtime versions do not stop the polling loop on abort.
    setTimeout(() => process.exit(1), 45000).unref();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  await runDevstarAgent({signal: controller.signal, handleEvent: createAdapter({
    ...backend, signal: controller.signal,
  })}, env);
}

function podAgentEnvironment(env) {
  if (!env.MINING_EXECUTION_BACKEND || env.MINING_EXECUTION_BACKEND === 'docker') return env;
  if (env.MINING_EXECUTION_BACKEND !== 'sd-pod') throw Error('Unknown mining execution backend');
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
