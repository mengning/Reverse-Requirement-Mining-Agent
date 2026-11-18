import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {requestRepoJSON, runDevstarAgent} from '../.devstar/agent-runtime/src/index.mjs';
import {runOfficialPipeline} from '../mining/official-run.mjs';
import {createHandler, validateRuntimeScope} from './handle-event.mjs';

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
  validateRuntimeScope(process.env);
  const {tasks} = JSON.parse(await readFile(new URL('../mining/tasks/official-catalog.json', import.meta.url), 'utf8'));
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    // Older template Runtime versions do not stop the polling loop on abort.
    setTimeout(() => process.exit(1), 45000).unref();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  await runDevstarAgent({signal: controller.signal, handleEvent: createAdapter({
    catalog: tasks.map(task => task.instance_id), pipeline: runOfficialPipeline, signal: controller.signal,
  })});
}
