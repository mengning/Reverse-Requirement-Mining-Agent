import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {publicationConfig} from './publish.mjs';

// Windows runners may terminate the step shell without terminating Node's
// descendants. Treat server state as a lease, not just a UI status.
export async function withWorkflowLifecycle(env,callback,{request=fetch,interval=2000,executionLabel}={}) {
  if(executionLabel!==undefined && !/^devstar-mining-run=[0-9a-f]{32}$/.test(executionLabel)) throw Error('Invalid mining execution label');
  const repository=env.GITHUB_REPOSITORY || env.GITEA_REPOSITORY;
  const run=env.GITHUB_RUN_ID || env.GITEA_RUN_ID;
  const revision=env.GITHUB_SHA || env.GITEA_SHA;
  const attempt=Number(env.MINING_RUN_ATTEMPT || env.GITHUB_RUN_ATTEMPT || env.GITEA_RUN_ATTEMPT);
  if(!/^[1-9][0-9]*$/.test(run || '') || !/^[0-9a-f]{40}$/.test(revision || '') || !Number.isSafeInteger(attempt) || attempt<1)
    throw Error('无法确认当前工作流版本及执行次数，未启动挖掘');
  const config=publicationConfig(repository,env),controller=new AbortController();
  const signal=controller.signal;
  const cancel=reason=>{if(!signal.aborted) controller.abort(reason instanceof Error?reason:Error('工作流已取消，停止挖掘且不再发布工单'));};
  const onSignal=()=>cancel();
  const assertActive=async()=>{
    signal.throwIfAborted();
    try {
      const response=await request(`${config.url}/api/v1/repos/${repository}/actions/runs/${run}/jobs`,{
        headers:{Authorization:`token ${config.token}`},redirect:'error',
        signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
      if(!response.ok) throw Error(`无法核对工作流状态（HTTP ${response.status}），停止挖掘`);
      const data=await response.json(),job=data.jobs?.[0];
      if(data.total_count!==1 || data.jobs?.length!==1 || String(job.run_id)!==run || job.head_sha!==revision || job.run_attempt!==attempt)
        throw Error('工作流执行身份已变化，停止挖掘');
      if(job.status!=='in_progress' || (job.conclusion && job.conclusion!==''))
        throw Error('工作流已取消或结束，停止挖掘且不再发布工单');
      signal.throwIfAborted();
    } catch(error) {cancel(error);throw signal.reason;}
  };
  let checking=false;
  let timer;
  process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);
  try {
    await assertActive();
    timer=setInterval(async()=>{
      if(checking || signal.aborted) return;
      checking=true;
      try {await assertActive();} catch {} finally {checking=false;}
    },interval);
    const guardedRequest=async(url,options={})=>{
      signal.throwIfAborted();
      if((options.method || 'GET').toUpperCase()!=='GET') await assertActive();
      signal.throwIfAborted();
      return request(url,{...options,signal:options.signal?AbortSignal.any([signal,options.signal]):signal});
    };
    const childEnv={...env,MINING_EXECUTION_LABEL:executionLabel || `devstar-mining-run=${randomUUID().replaceAll('-','')}`};
    const result=await callback({env:childEnv,signal,request:guardedRequest});
    signal.throwIfAborted();
    return result;
  } finally {
    clearInterval(timer);
    process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);
  }
}

function command(file,args) {
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',data=>{stdout+=data;});
    child.stderr.on('data',data=>{stderr+=data;});
    const timer=setTimeout(()=>child.kill(),15000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{clearTimeout(timer);code===0?resolve(stdout):reject(Error(`${file} cleanup failed (${code}): ${stderr.slice(-300)}`));});
  });
}

export async function stopMiningContainers(label) {
  if(!/^devstar-mining-run=[0-9a-f]{32}$/.test(label || '')) return;
  const ids=(await command('docker',['ps','-aq','--filter',`label=${label}`])).trim().split(/\s+/).filter(Boolean);
  if(ids.some(id=>! /^[0-9a-f]{12,64}$/.test(id))) throw Error('无法确认本次探索容器，拒绝清理其他容器');
  if(ids.length) await command('docker',['rm','--force',...ids]);
}

export function runMiningProcess(file,args,{env,signal,cwd,stdio='inherit',ownGroup=env?.MINING_PROCESS_GROUP!=='shared'}={}) {
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{env,cwd,stdio,windowsHide:true,detached:process.platform!=='win32' && ownGroup});
    let cleanup;
    const stop=()=>{
      cleanup=(async()=>{
        try {
          if(process.platform==='win32') await command('taskkill',['/PID',String(child.pid),'/T','/F']);
          else {try {ownGroup?process.kill(-child.pid,'SIGKILL'):child.kill('SIGKILL');} catch(error) {if(error.code!=='ESRCH') throw error;}}
        } finally {await stopMiningContainers(env?.MINING_EXECUTION_LABEL);}
      })();
      // close awaits this promise; attach a handler immediately as cleanup can
      // fail before the process close event is delivered.
      cleanup.catch(error=>{
        // A cleanup permission failure must fail visibly, not leave the step
        // waiting forever for a descendant it was unable to terminate.
        child.kill();
        reject(error);
      });
    };
    signal?.addEventListener('abort',stop,{once:true});
    child.once('error',error=>{signal?.removeEventListener('abort',stop);reject(error);});
    child.once('close',async(code,exitSignal)=>{
      signal?.removeEventListener('abort',stop);
      try {
        if(cleanup) await cleanup;
        signal?.throwIfAborted();
        if(code!==0) throw Error(`需求挖掘未完成 (${exitSignal || code})，未发布工单`);
        resolve();
      } catch(error) {reject(error);}
    });
    if(signal?.aborted) stop();
  });
}
