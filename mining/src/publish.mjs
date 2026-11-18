import {readFile,writeFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {hash} from './hash.mjs';

// Environment keys whose values must never appear in published issue material.
// Values shorter than this are ignored to avoid rejecting ordinary prose, but
// the authenticated DEVSTAR_TOKEN is always checked verbatim.
const sensitiveKey=/(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|CREDENTIAL|AUTH)/i;
const MIN_SECRET_LENGTH=8;

function publicSourceOrigin(key,value) {
  if(key!=='MINING_SOURCE_CREDENTIAL_ORIGIN') return false;
  try {
    const url=new URL(value);
    return ['http:','https:'].includes(url.protocol) && !url.username && !url.password &&
      url.pathname==='/' && !url.search && !url.hash;
  } catch {return false;}
}

function secretCandidates(env,token) {
  const values=new Set();
  for(const value of [token,typeof token==='string'?token.trim():'']) if(value) values.add(value);
  for(const [key,value] of Object.entries(env || {})) {
    if(!sensitiveKey.test(key) || typeof value!=='string' || publicSourceOrigin(key,value)) continue;
    const trimmed=value.trim();
    if(trimmed.length>=MIN_SECRET_LENGTH) values.add(trimmed);
  }
  return Object.freeze([...values]);
}

export function publicationConfig(repository,env=process.env) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw Error('Expected OWNER/REPO');
  let url;
  try {url=new URL(env.DEVSTAR_URL || 'http://127.0.0.1:18087');}
  catch {throw Error('Expected a valid loopback DevStar or HTTPS workflow server URL');}
  const local=url.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  let remote=false;
  if (url.protocol==='https:') {
    if (!env.GITHUB_SERVER_URL) throw Error('Expected the HTTPS workflow server origin');
    try {remote=new URL(env.GITHUB_SERVER_URL).origin===url.origin;}
    catch {throw Error('Expected GITHUB_SERVER_URL to be a valid HTTPS URL');}
  }
  if ((!local && !remote) || url.username || url.password || url.pathname!=='/' || url.search || url.hash)
    throw Error('Expected loopback DevStar or the HTTPS workflow server origin');
  if (!env.DEVSTAR_TOKEN?.trim()) throw Error('DEVSTAR_TOKEN required');
  // Keep the credential (and the derived leak-check list) out of accidental
  // JSON logging or object spreads; callers read config.token explicitly.
  const config={url:url.origin,repository};
  Object.defineProperties(config,{
    token:{value:env.DEVSTAR_TOKEN,enumerable:false},
    secrets:{value:secretCandidates(env,env.DEVSTAR_TOKEN),enumerable:false},
  });
  return config;
}

export async function checkRepository(config,request=fetch) {
  const response=await request(`${config.url}/api/v1/repos/${config.repository}`,{
    headers:{Authorization:`token ${config.token}`},redirect:'error',signal:AbortSignal.timeout(30000)});
  if (!response.ok) throw Error(`DevStar repository check HTTP ${response.status}`);
  const repo=await response.json();
  if (!repo || repo.full_name!==config.repository || repo.has_issues===false || repo.archived)
    throw Error('Target repository is not available for issues');
}

// Reserve the receipt before POST so a response lost after a server commit is
// never silently retried. A concurrent publisher that lost the `wx` race gets
// a readable outcome instead of a bare EEXIST stack trace.
export async function reserveReceipt(receiptFile,binding) {
  try {
    await writeFile(receiptFile,JSON.stringify({...binding,status:'submitting'}),{flag:'wx',mode:0o600});
  } catch(error) {
    if(error.code!=='EEXIST') throw error;
    const conflict=new Error('已有发布回执或另一进程正在发布；请先核对已有工单，结果未确认前不要重复提交。');
    conflict.code='EEXIST';
    conflict.cause=error;
    throw conflict;
  }
}

export async function publishIssue(issue,config,receiptFile,request=fetch) {
  if (typeof issue?.title!=='string' || !issue.title.trim() || typeof issue.body!=='string' ||
      !issue.body.trim() || Buffer.byteLength(issue.body)>50000) throw Error('Invalid ordinary issue');
  const secrets=new Set(Array.isArray(config.secrets)?config.secrets:[]);
  if (typeof config.token==='string' && config.token) secrets.add(config.token);
  if ([...secrets].some(secret=>secret && (issue.title.includes(secret) || issue.body.includes(secret))))
    throw Error('发布材料包含敏感环境值（可能是 token）；已拒绝建单，请检查标题和正文。');
  const payload={title:issue.title,body:issue.body};
  const binding={url:config.url,repository:config.repository,input_sha256:hash(payload)};
  let prior;
  try {
    prior=JSON.parse(await readFile(receiptFile,'utf8'));
  } catch(error) {
    if (error.code!=='ENOENT' && !(error instanceof SyntaxError)) throw error;
    if (error instanceof SyntaxError) throw Error('发布回执无法解析；请先人工核对已有工单，不要重复提交。',{cause:error});
  }
  if (prior!==undefined) {
    if (!prior || typeof prior!=='object') throw Error('发布回执格式无效；请先人工核对已有工单，不要重复提交。');
    if (Object.entries(binding).some(([k,v])=>prior[k]!==v))
      throw Error('Publication receipt does not match this input or destination');
    if (prior.status!=='created' || !Number.isSafeInteger(prior.number) || prior.number<=0) {
      throw Error('Submission outcome is uncertain; reconcile the existing issue before retrying');
    }
    return prior;
  }
  await reserveReceipt(receiptFile,binding);
  const response=await request(`${config.url}/api/v1/repos/${config.repository}/issues`,{
    method:'POST',headers:{Authorization:`token ${config.token}`,'Content-Type':'application/json'},
    body:JSON.stringify(payload).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')),
    redirect:'error',signal:AbortSignal.timeout(30000)});
  if (!response.ok) throw Error(`Issue creation HTTP ${response.status}; reconcile receipt before retrying`);
  let result;
  try {result=await response.json();}
  catch(error) {throw Error('Issue creation response is not valid JSON; reconcile receipt before retrying',{cause:error});}
  if (!result || typeof result!=='object' || !Number.isSafeInteger(result.number) || result.number<=0 ||
      result.title!==payload.title || result.body!==payload.body) {
    throw Error('Created issue response does not match submitted content; reconcile receipt');
  }
  const receipt={...binding,status:'created',number:result.number,
    issue_url:`${config.url}/${config.repository}/issues/${result.number}`};
  const temporary=receiptFile+'.'+randomUUID()+'.tmp';
  await writeFile(temporary,JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
  await rename(temporary,receiptFile);
  return receipt;
}
