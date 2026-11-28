import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {requestRepoJSON} from '../.devstar/agent-runtime/src/index.mjs';
import {readFixedProbes} from './fixed-probes.mjs';

const instancePattern = /^[A-Za-z0-9._-]+__[A-Za-z0-9._-]+\.[0-9a-f]{7,40}$/;
const instructionInstance = /(?<![A-Za-z0-9._-])[A-Za-z0-9._-]+__[A-Za-z0-9._-]+\.[0-9a-f]{7,40}(?![A-Za-z0-9_-]|\.[A-Za-z0-9])/g;
const programName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const benchmarkName = /\bProgramBench[ \t]*(?:的[ \t]*)?(?:(?:官方[ \t]*)?(?:任务目录|目录|样例|实例|程序|任务)(?:中|里)?(?:的)?[ \t]*|官方[ \t]+|(?:official[ \t]+)?(?:sample|instance|program)[ \t]+)?`?([A-Za-z0-9][A-Za-z0-9._-]*)`?/gi;
const alternativeName = /^[ \t]*(?:或(?:者)?|与|和|、|\/|\b(?:or|and)\b)[ \t]*`?[A-Za-z0-9]/i;
const repoPattern = /^[\w.-]+\/[\w.-]+$/;
const positiveInt = (value) => /^[1-9]\d*$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value));
const validRepository = (name) => typeof name === 'string' && name === name.trim() &&
  repoPattern.test(name) && name.split('/').every(part => part !== '.' && part !== '..');

function isIssueDelegation(body) {
  return body.source === 'agent_command' && body.source_event === 'issue_comment' &&
    body.capability === 'requirements-mining' && positiveInt(body.issue?.number) && !body.chat_run_id && !body.pull_request;
}

function isChatDelegation(body) {
  return ((body.source === 'chatbot_tool' && body.agent_capability_id === 'requirements-mining') ||
    (body.source === 'agent_command' && body.capability === 'requirements-mining')) &&
    Boolean(String(body.chat_run_id ?? '').trim()) && !body.pull_request;
}

function authorizesSourceClosure(source) {
  return /^(?:本单|本工单)(?:仅用于|只用于)需求挖掘[。；;]\s*(?:需求工单|新需求工单)(?:创建|发布|交付)后关闭本(?:工)?单[。！!]?$/mu.test(source.body);
}

function lookupInstance(body, known, aliases) {
  const command = String(body?.command ?? '').trim();
  const parts = command.split(/\s+/);
  if (parts[0] !== '/mine') return {};
  const instruction = String(body.instruction ?? body.workflow?.selected_operation ?? '').trim();
  let name;
  if ((!isIssueDelegation(body) && !isChatDelegation(body)) || !instruction) {
    if (parts.length !== 2) return {};
    if (instancePattern.test(parts[1])) return known.has(parts[1]) ? {instance: parts[1]} : {};
    name = parts[1];
  } else {
    // Runtime may append the separate Planner instruction to the verb before invoking us.
    if (instruction.length > 8000) return {};
    if (command !== '/mine' && command !== `/mine ${instruction}`) {
      if (!isChatDelegation(body) || parts.length !== 2) return {};
      if (instancePattern.test(parts[1])) return known.has(parts[1]) ? {instance: parts[1]} : {};
      name = parts[1];
    }
    const ids = new Set(instruction.match(instructionInstance));
    if (ids.size) {
      const [instance] = ids;
      return ids.size === 1 && known.has(instance) && (!name || aliases.get(name.toLowerCase())?.includes(instance)) ? {instance} : {};
    }
    const mentions = [...instruction.matchAll(benchmarkName)];
    if (mentions.some(m => alternativeName.test(instruction.slice(m.index + m[0].length)))) return {};
    const names = new Set(mentions.map(m => m[1].toLowerCase().replace(/\.$/, '')));
    if (names.size > 1 || (name && names.size && !names.has(name.toLowerCase()))) return {};
    if (!name) [name] = names;
  }
  if (!name || !programName.test(name)) return {};
  const matches = aliases.get(name.toLowerCase()) ?? [];
  return matches.length === 1 ? {instance: matches[0]} : {name, matches};
}

export function validateRuntimeScope(env) {
  const id = String(env.DEVSTAR_AGENT_SCOPE_REPO_ID ?? '');
  if (env.DEVSTAR_AGENT_SCOPE_KIND !== 'repository' || !positiveInt(id)) {
    throw new Error('Mining requires an explicit repository scope');
  }
  const legacyName = env.MINING_AGENT_REPOSITORY;
  if (legacyName && !validRepository(legacyName)) throw new Error('Invalid MINING_AGENT_REPOSITORY');
  if (!env.WORK_REPO_ID) return {id, name: legacyName || undefined};
  const name = env.WORK_REPO_OWNER && env.WORK_REPO_NAME && `${env.WORK_REPO_OWNER}/${env.WORK_REPO_NAME}`;
  if (String(env.WORK_REPO_ID) !== id || !validRepository(name) || (legacyName && legacyName !== name)) {
    throw new Error('Mining workspace does not match the bound repository');
  }
  return {id, name};
}

export function createHandler({catalog, pipeline, signal, readIssue = requestRepoJSON, postResult}) {
  const known = new Set(catalog);
  const aliases = new Map();
  for (const id of known) {
    if (!instancePattern.test(id)) continue;
    const name = id.slice(id.indexOf('__') + 2, id.lastIndexOf('.')).toLowerCase();
    aliases.set(name, [...(aliases.get(name) ?? []), id]);
  }
  return async function handleEvent(event, env) {
    const {id: repoID, name: boundName} = validateRuntimeScope(env);
    // The Runtime supplies the repository on the event envelope, not in the instruction.
    const repository = event.repository?.full_name;
    if (String(event.repository?.id) !== repoID || !validRepository(repository) ||
        (boundName && repository !== boundName) || !positiveInt(event.event_id)) {
      throw new Error('Mining requires an event from the bound repository');
    }
    if (event.body?.pull_request || event.body?.issue?.pull_request) {
      return {status: 'input_required', summary: '请从挖掘任务工单或仓库 ChatBot 发起需求挖掘，不在 PR 上执行。'};
    }

    const {instance, name, matches} = lookupInstance(event.body, known, aliases);
    if (!instance) {
      const summary = matches?.length
        ? `目录中有多个名为 ${name} 的样例，请选一个：${matches.slice(0, 8).join('、')}。`
        : name ? `当前目录没有可运行的 ${name} 样例。请确认要测哪个程序。` : '请明确要测的一个 ProgramBench 程序。';
      return {status: 'input_required', summary: summary + ' 未启动探测或建单。'};
    }

    const platform = new URL(env.SELF_URL || env.DEVSTAR_PLATFORM_URL);
    if (platform.username || platform.password || platform.pathname !== '/' || platform.search || platform.hash) {
      throw new Error('Expected a trusted DevStar origin');
    }
    const credential = event.credentials?.service_account?.token;
    if (!String(credential ?? '').trim()) throw new Error('The delegated event has no service-account credential');
    const chat = isChatDelegation(event.body);
    const sourceNumber = chat ? null : event.body.issue?.number;
    let source;
    if (positiveInt(sourceNumber) && !event.body.pull_request) {
      source = await readIssue(event, 'GET', `/issues/${Number(sourceNumber)}`, undefined, env);
      if (Number(source?.number) !== Number(sourceNumber) || typeof source.body !== 'string' || source.pull_request)
        throw new Error('Cannot verify the source issue');
      try {
        if (readFixedProbes(source.body).length)
          return {status: 'input_required', summary: '官方探索运行器不保证固定参数和输入原样执行。未运行探测或建单。'};
      } catch (error) {
        return {status: 'input_required', summary: error.message};
      }
    }
    const stateRoot = env.MINING_AGENT_STATE_DIR || path.join(env.AGENT_REPO_PATH || '', '.devstar', 'runtime', 'mining');
    if (!path.isAbsolute(stateRoot)) throw new Error('Mining needs an absolute persistent AGENT_REPO_PATH or MINING_AGENT_STATE_DIR');
    const state = path.join(stateRoot, repoID, String(event.event_id));
    if (source?.state === 'closed') {
      const prior = await readFile(path.join(state, 'publication.json'), 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return '';
      });
      if (!prior || JSON.parse(prior).status !== 'created')
        return {status: 'input_required', summary: '挖掘任务工单已关闭，未启动探测或建单。'};
    }
    const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) =>
      /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|LANG|LC_ALL|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|DOCKER_CERT_PATH|DOCKER_TLS_VERIFY|OPENJIUWEN_API_BASE|OPENJIUWEN_API_KEY|OPENJIUWEN_MODEL|MINING_PYTHON|MINING_OFFICIAL_IMAGE_ID|MINING_OFFICIAL_LAB_LABEL|MINING_OFFICIAL_RECOVERY_SOURCE|MINING_SCOPE)$/i.test(name)));
    const sourceIssue = isIssueDelegation(event.body) ? Number(sourceNumber) : undefined;
    const receipt = await pipeline(instance, state, repository, {signal, sourceIssue, recoverIncomplete: true, env: {
      ...childEnv, DEVSTAR_URL: platform.origin, GITHUB_SERVER_URL: platform.origin, DEVSTAR_TOKEN: credential,
      MINING_EXECUTION_LABEL: `devstar-mining-run=${randomUUID().replaceAll('-', '')}`,
    }});
    const issue = new URL(receipt.issue_url);
    if (!positiveInt(receipt.number) || receipt.number === sourceIssue || issue.origin !== platform.origin ||
        issue.pathname !== `/${repository}/issues/${receipt.number}`) {
      throw new Error('Publication did not return an issue in the bound repository');
    }
    let summary = `需求挖掘完成：[查看需求工单 #${receipt.number}](${issue.href})。规格编写请在新工单继续。`;
    if (sourceIssue && source?.state !== 'closed' && authorizesSourceClosure(source) && postResult) {
      // The shared Runtime writes/reuses the one native receipt before we close.
      const linked = await postResult(event, summary, env);
      if (!positiveInt(linked?.id)) throw Error('Could not verify the source issue receipt');
      try {
        const current = await readIssue(event, 'GET', `/issues/${sourceIssue}`, undefined, env);
        if (current?.number === sourceIssue && current.state === 'open' && current.body === source.body && current.title === source.title) {
          const closed = await readIssue(event, 'PATCH', `/issues/${sourceIssue}`, {state: 'closed'}, env);
          if (closed?.number !== sourceIssue || closed.state !== 'closed') summary += ' 原任务未确认关闭。';
        } else if (current?.state !== 'closed') {
          summary += ' 原任务已有变更，未关闭。';
        }
      } catch {
        summary += ' 原任务未确认关闭，可人工核对。';
      }
    }
    return {summary,
      result: {issue_number: receipt.number, issue_url: issue.href}};
  };
}
