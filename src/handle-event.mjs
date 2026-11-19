import path from 'node:path';
import {randomUUID} from 'node:crypto';

const instancePattern = /^[A-Za-z0-9._-]+__[A-Za-z0-9._-]+\.[0-9a-f]{7,40}$/;
const repoPattern = /^[\w.-]+\/[\w.-]+$/;
const positiveInt = (value) => /^[1-9]\d*$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value));

export function validateRuntimeScope(env) {
  const repoID = env.DEVSTAR_AGENT_SCOPE_REPO_ID;
  if (env.DEVSTAR_AGENT_SCOPE_KIND !== 'repository' || !positiveInt(repoID)) {
    throw new Error('Mining requires an explicit repository scope');
  }
  const explicit = env.MINING_AGENT_REPOSITORY;
  if (env.WORK_REPO_OWNER || env.WORK_REPO_NAME || env.WORK_REPO_ID) {
    const repository = `${env.WORK_REPO_OWNER || ''}/${env.WORK_REPO_NAME || ''}`;
    if (!repoPattern.test(repository) || !positiveInt(env.WORK_REPO_ID) ||
        Number(env.WORK_REPO_ID) !== Number(repoID) || (explicit && explicit !== repository)) {
      throw new Error('Mining workspace does not match the repository scope');
    }
    return {repoID, repository};
  }
  if (!repoPattern.test(explicit || '')) throw new Error('Mining requires a bound repository name');
  return {repoID, repository: explicit};
}

export function createHandler({catalog, pipeline, signal}) {
  const known = new Set(catalog);
  return async function handleEvent(event, env) {
    const {repository, repoID} = validateRuntimeScope(env);
    if (event.repository?.full_name !== repository ||
        Number(event.repository?.id) !== Number(repoID) || !positiveInt(event.event_id)) {
      throw new Error('Mining requires an event from the bound repository');
    }

    const parts = String(event.body?.command ?? '').trim().split(/\s+/);
    const instance = parts[1];
    if (parts.length !== 2 || parts[0] !== '/mine' || !instancePattern.test(instance) || !known.has(instance)) {
      return {status: 'input_required', summary: '请使用 /mine 加一个目录中的 ProgramBench 实例标识，例如 /mine chmln__sd.87d1ba5。未启动探测或建单。'};
    }

    const platform = new URL(env.SELF_URL || env.DEVSTAR_PLATFORM_URL);
    if (platform.username || platform.password || platform.pathname !== '/' || platform.search || platform.hash) {
      throw new Error('Expected a trusted DevStar origin');
    }
    const credential = event.credentials?.service_account?.token;
    if (!String(credential ?? '').trim()) throw new Error('The delegated event has no service-account credential');
    if (!path.isAbsolute(env.MINING_AGENT_STATE_DIR || '')) throw new Error('MINING_AGENT_STATE_DIR must be an absolute persistent path');
    const state = path.join(env.MINING_AGENT_STATE_DIR, String(repoID), String(event.event_id));
    const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) =>
      /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|LANG|LC_ALL|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|DOCKER_CERT_PATH|DOCKER_TLS_VERIFY|OPENJIUWEN_API_BASE|OPENJIUWEN_API_KEY|OPENJIUWEN_MODEL|MINING_PYTHON)$/i.test(name)));
    const receipt = await pipeline(instance, state, repository, {signal, recoverIncomplete: true, env: {
      ...childEnv, DEVSTAR_URL: platform.origin, GITHUB_SERVER_URL: platform.origin, DEVSTAR_TOKEN: credential,
      MINING_EXECUTION_LABEL: `devstar-mining-run=${randomUUID().replaceAll('-', '')}`,
    }});
    const issue = new URL(receipt.issue_url);
    if (!positiveInt(receipt.number) || issue.origin !== platform.origin ||
        issue.pathname !== `/${repository}/issues/${receipt.number}`) {
      throw new Error('Publication did not return an issue in the bound repository');
    }
    return {summary: `需求挖掘完成：[查看需求工单 #${receipt.number}](${issue.href})。`,
      result: {issue_number: receipt.number, issue_url: issue.href}};
  };
}
