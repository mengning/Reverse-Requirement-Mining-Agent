import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {runOfficialPipeline} from '../mining/official-run.mjs';
import {createHandler, validateRuntimeScope} from './handle-event.mjs';

export function createAdapter(options) {
  return createHandler(options);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.length > 2) throw Error('The ProgramBench Agent does not accept startup arguments');
  const env = process.env;
  if (env.MINING_EXECUTION_BACKEND && env.MINING_EXECUTION_BACKEND !== 'docker')
    throw Error('Only the official ProgramBench execution backend is supported');
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
  const catalog = env.MINING_OFFICIAL_INSTANCE ? [env.MINING_OFFICIAL_INSTANCE] : officialCatalog;
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    // Older template Runtime versions do not stop the polling loop on abort.
    setTimeout(() => process.exit(1), 45000).unref();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  await runDevstarAgent({signal: controller.signal, handleEvent: createAdapter({
    catalog, pipeline: runOfficialPipeline, postResult, signal: controller.signal,
  })}, env);
}
