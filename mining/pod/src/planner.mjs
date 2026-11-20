import {access,mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const REQUEST_LIMIT=240000;
const REQUEST_HEADROOM=2048;
const BUDGET_VERSION='mining-token-budget/v1';

const exists=async file=>{
  try {await access(file);return true;}
  catch(error) {if(error.code==='ENOENT') return false;throw error;}
};
const bodyFor=(messages,maxTokens)=>JSON.stringify({model:'configured-model',messages,response_format:{type:'json_object'},max_tokens:maxTokens,temperature:0});
const bodyBytes=(messages,maxTokens)=>Buffer.byteLength(bodyFor(messages,maxTokens));

function excerptText(value,cap) {
  if(typeof value!=='string' || value.length<=cap) return null;
  return {text:`${value.slice(0,cap)}\n…[确定性摘录：原文 ${value.length} 字符，仅发送前 ${cap} 字符；完整原文保留在本地证据，未发送给模型]`,
    original_length:value.length,kept_length:cap};
}

function compactUserPayload(content,caps,excerpts) {
  let payload;
  try {payload=JSON.parse(content);} catch {return content;}
  if(!payload || typeof payload!=='object' || Array.isArray(payload)) return content;
  let changed=false;
  const record=(kind,id,field,result)=>excerpts.push({kind,id,field,original_length:result.original_length,kept_length:result.kept_length});
  for(const document of Array.isArray(payload.documents)?payload.documents:[]) {
    const result=excerptText(document?.text,caps.document);
    if(result) {
      document.text=result.text;document.excerpt=true;
      document.original_length=result.original_length;document.kept_length=result.kept_length;
      record('document',document.id,'text',result);changed=true;
    }
  }
  for(const observation of Array.isArray(payload.observations)?payload.observations:[]) {
    for(const field of ['stdout','stderr','stdin','file_text']) {
      const result=excerptText(observation?.[field],caps.observation);
      if(result) {
        observation[field]=result.text;
        observation.excerpt_fields={...(observation.excerpt_fields||{}),[field]:{original_length:result.original_length,kept_length:result.kept_length}};
        record('observation',observation.id,field,result);changed=true;
      }
    }
    for(const field of ['stdout','stderr']) {
      const result=excerptText(observation?.repeat_result?.[field],caps.observation);
      if(result) {
        observation.repeat_result[field]=result.text;
        observation.repeat_result.excerpt_fields={...(observation.repeat_result.excerpt_fields||{}),
          [field]:{original_length:result.original_length,kept_length:result.kept_length}};
        record('repeat_result',observation.id,field,result);changed=true;
      }
    }
    // raw_bytes carries base64 of the full capture (HTTP bodies reach 16KiB →
    // ~21KiB of base64 per field). The decoded text is already sent as
    // stdout/stderr, so the model never needs the base64: exclude it
    // deterministically and keep only decoded sizes + a local-evidence note.
    const compactRawBytes=(rawBytes,id)=>{
      if(!rawBytes || typeof rawBytes!=='object') return rawBytes;
      const summary={excluded:true,note:'base64 原文完整保留在本地证据，未随请求发送；解码后的文本见 stdout/stderr。'};
      let measured=0;
      for(const field of ['stdout_base64','stderr_base64']) {
        const value=rawBytes[field];
        // Empty base64 carries no payload: keep the original object instead of
        // reporting a meaningless exclusion.
        if(typeof value!=='string' || value.length===0) continue;
        summary[`${field.replace('_base64','')}_decoded_bytes`]=Buffer.from(value,'base64').length;
        excerpts.push({kind:'raw_bytes',id,field,original_length:value.length,kept_length:0});
        measured+=1;
      }
      return measured>0?summary:rawBytes;
    };
    const rawBytes=compactRawBytes(observation?.raw_bytes,observation?.id);
    if(rawBytes!==observation?.raw_bytes) {observation.raw_bytes=rawBytes;changed=true;}
    if(observation?.repeat_result) {
      const repeated=compactRawBytes(observation.repeat_result.raw_bytes,observation?.id);
      if(repeated!==observation.repeat_result.raw_bytes) {observation.repeat_result.raw_bytes=repeated;changed=true;}
    }
  }
  if(changed) {
    payload.evidence_excerpts={applied:true,
      note:'为满足请求体积上限，长文本按确定性规则摘录；以下仅发送前缀，完整原文仍保留在本地证据，不据此伪造内容。',
      items:excerpts};
  }
  return changed?JSON.stringify(payload):content;
}

// Deterministic preflight before the hard request limit: long public documents and
// observations are excerpted with explicit metadata instead of being silently cut.
export function compactMessages(messages,{limit=REQUEST_LIMIT,headroom=REQUEST_HEADROOM,maxTokens=16384}={}) {
  if(bodyBytes(messages,maxTokens)<=limit-headroom) return {messages,excerpts:[]};
  const tiers=[
    {document:16000,observation:8000},
    {document:8000,observation:4000},
    {document:4000,observation:2000},
    {document:2000,observation:1000},
    {document:1000,observation:500},
    {document:500,observation:250},
  ];
  for(const caps of tiers) {
    const excerpts=[];
    const candidate=messages.map(message=>message?.role==='user'?{...message,content:compactUserPayload(message.content,caps,excerpts)}:message);
    if(bodyBytes(candidate,maxTokens)<=limit-headroom) return {messages:candidate,excerpts};
  }
  throw new Error(`Public material exceeds request budget (${bodyBytes(messages,maxTokens)} bytes, limit ${limit}) even after deterministic excerpting; no request sent`);
}

export function modelPlanner(env=process.env, request=fetch, {onUsage=()=>{},diagnosticDir,stage:fixedStage}={}) {
  let url;
  try {url=new URL(env.OPENJIUWEN_API_BASE);} catch {throw Error('Configured model API URL required');}
  const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if((url.protocol!=='https:' && !(url.protocol==='http:' && loopback)) || url.username || url.password || url.search || url.hash || !env.OPENJIUWEN_API_KEY || !env.OPENJIUWEN_MODEL) {
    throw new Error('Configured HTTPS or loopback model API required; no provider fallback');
  }
  const endpoint=url.href.replace(/\/$/,'');
  // Workflow variables that are declared but left empty arrive as ''. They mean
  // "not configured", exactly like an unset variable, not an empty value.
  const configured=name=>typeof env[name]==='string' && env[name].trim()!==''?env[name].trim():undefined;
  const maxTokens=Number(configured('MINING_MODEL_MAX_TOKENS') ?? 16384);
  if(!Number.isInteger(maxTokens) || maxTokens<512 || maxTokens>16384) throw Error('Invalid model output budget');
  // Explicit configuration always wins. The model-vendor default is kept for the
  // official endpoint, while compatible endpoints can pass the value explicitly.
  const effort=configured('OPENJIUWEN_REASONING_EFFORT') ?? configured('MINING_REASONING_EFFORT') ??
    (url.hostname==='api.deepseek.com'?'none':undefined);
  if(effort!==undefined && !['none','low','high','max'].includes(effort)) throw Error('Invalid reasoning effort');
  const budgetValue=configured('MINING_TOTAL_TOKEN_BUDGET');
  const totalBudget=budgetValue===undefined?undefined:Number(budgetValue);
  if(totalBudget!==undefined && (!Number.isSafeInteger(totalBudget) || totalBudget<1)) throw Error('Invalid total token budget');
  const counters={discovery:0,synthesis:0};
  let usedTokens=0;
  // Persist cumulative usage in the run output directory when one is known.
  // Without a stable directory the budget still works in-process, but there is
  // no cross-resume state to trust. Entry points pass diagnosticDir=output.
  const budgetDirectory=diagnosticDir || env.MINING_DISCOVERY_OUTPUT || env.MINING_OUTPUT_DIR;
  const budgetFile=totalBudget!==undefined && budgetDirectory ? path.join(budgetDirectory,'model-token-budget.json') : undefined;
  let budgetLoaded=!budgetFile;
  async function loadBudgetState() {
    if(budgetLoaded) return;
    try {
      const saved=JSON.parse(await readFile(budgetFile,'utf8'));
      if(!saved || saved.version!==BUDGET_VERSION || !Number.isSafeInteger(saved.used_tokens) || saved.used_tokens<0)
        throw Error('Persisted token budget state is invalid; refusing to reset usage to zero');
      usedTokens=saved.used_tokens;
    } catch(error) {
      if(error.code!=='ENOENT') {
        if(error instanceof SyntaxError)
          throw Error('Persisted token budget state is not valid JSON; refusing to reset usage to zero');
        throw error;
      }
    }
    budgetLoaded=true;
  }
  async function persistBudgetState() {
    if(!budgetFile) return;
    await mkdir(path.dirname(budgetFile),{recursive:true});
    const temporary=`${budgetFile}.${randomUUID()}.tmp`;
    await writeFile(temporary,JSON.stringify({version:BUDGET_VERSION,total_budget:totalBudget,used_tokens:usedTokens,
      updated_at:new Date().toISOString()},null,2)+'\n',{flag:'wx',mode:0o600});
    await rename(temporary,budgetFile);
  }
  const stageOf=(messages,explicit)=>{
    if(explicit) return explicit;
    if(fixedStage) return fixedStage;
    return /独立的需求归纳器/.test(String(messages?.[0]?.content||''))?'synthesis':'discovery';
  };
  const diagnosticDirectory=()=>diagnosticDir || env.MINING_DISCOVERY_OUTPUT || env.MINING_OUTPUT_DIR || path.join(os.tmpdir(),'mining-diagnostics');
  async function persistTruncated(record) {
    const directory=diagnosticDirectory();
    await mkdir(directory,{recursive:true});
    const base=`${record.stage}-truncated-response`;
    let file=path.join(directory,`${base}.json`),suffix=2;
    while(await exists(file)) file=path.join(directory,`${base}-${suffix++}.json`);
    await writeFile(file,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
    return file;
  }
  return async (messages,callOptions={})=>{
    const stage=stageOf(messages,callOptions.stage);
    const sequence=++counters[stage];
    if(totalBudget!==undefined) await loadBudgetState();
    if(totalBudget!==undefined && usedTokens>=totalBudget) {
      throw new Error(`累计 token 预算已用尽（已用 ${usedTokens}/${totalBudget}，stage=${stage}，request=${sequence}）。未发送新请求；已完成轮次检查点保留，可用 --resume-from 检查点继续，已有观察不会重复执行。`);
    }
    const compacted=compactMessages(messages,{maxTokens});
    const body=JSON.stringify({model:env.OPENJIUWEN_MODEL,messages:compacted.messages,response_format:{type:'json_object'},
      max_tokens:maxTokens,temperature:0,...(effort!==undefined?{reasoning_effort:effort}:{})});
    if(Buffer.byteLength(body)>REQUEST_LIMIT) {
      throw new Error(`Public material exceeds request budget (${Buffer.byteLength(body)} > ${REQUEST_LIMIT}) after deterministic excerpting; no request sent; completed checkpoint preserved`);
    }
    const response=await request(endpoint+'/chat/completions',{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.OPENJIUWEN_API_KEY}`},body,
      signal:AbortSignal.timeout(180000),redirect:'error',
    });
    if(!response.ok) throw new Error(`Discovery model HTTP ${response.status}; not retried`);
    const data=await response.json();
    const usage=Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens'].filter(k=>Number.isSafeInteger(data.usage?.[k]) && data.usage[k]>=0).map(k=>[k,data.usage[k]]));
    const completeUsage=Number.isSafeInteger(usage.total_tokens) && usage.total_tokens>=0;
    if(totalBudget!==undefined && !completeUsage) {
      await onUsage(usage);
      throw new Error(`模型接口未返回完整 usage（缺少 total_tokens）；累计 token 预算状态未知，已停止以避免按 0 放行（stage=${stage}，request=${sequence}）。`);
    }
    const tokens=completeUsage?usage.total_tokens:
      (Number.isSafeInteger(usage.prompt_tokens)&&Number.isSafeInteger(usage.completion_tokens)?usage.prompt_tokens+usage.completion_tokens:0);
    usedTokens+=tokens;
    if(totalBudget!==undefined) await persistBudgetState();
    await onUsage(usage);
    const choice=data.choices?.[0],content=choice?.message?.content;
    if(choice?.finish_reason!=='stop' || typeof content!=='string' || content.length>100000) {
      let saved;
      try {saved=await persistTruncated({version:'mining-truncated-response/v1',stage,request:sequence,
        finish_reason:choice?.finish_reason??null,max_tokens:maxTokens,usage,
        content:typeof content==='string'?content:null,content_length:typeof content==='string'?content.length:null,
        created_at:new Date().toISOString()});}
      catch(error) {saved=`<save failed: ${error.message}>`;}
      throw new Error(`Incomplete or oversized ${stage} response (finish=${choice?.finish_reason || 'missing'}, completion_tokens=${data.usage?.completion_tokens ?? 'unknown'}; max_tokens=${maxTokens}, request=${sequence}, stage=${stage}). 截断原文已保存到 ${saved}；请用 --resume-from 已完成检查点继续，已有观察不会重复执行。`);
    }
    if(totalBudget!==undefined && usedTokens>totalBudget) {
      throw new Error(`累计 token 预算超限（已用 ${usedTokens}/${totalBudget}，stage=${stage}，request=${sequence}）。响应未采用；已完成轮次检查点保留，可用 --resume-from 检查点继续，已有观察不会重复执行。`);
    }
    return JSON.parse(content);
  };
}
