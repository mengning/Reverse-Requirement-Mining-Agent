import {spawnMiningSync as spawnSync} from './mining-command.mjs';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {normalizeTask,validateProbe,serviceDriverConfig,WRITABLE_FILE} from './task.mjs';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const check = (value, message) => { if (!value) throw new Error(message); };
const httpDriver=readFileSync(new URL('./drivers/http-service.py',import.meta.url),'utf8');
const textOf=value=>Buffer.isBuffer(value)?value.toString('utf8'):typeof value==='string'?value:'';
const oneLine=value=>String(value??'').replace(/\s+/g,' ').trim();
const tail=(value,limit=800)=>{const text=oneLine(value);return text.length>limit?`…${text.slice(-limit)}`:text;};
const redact=text=>text
  .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,'$1 [redacted]')
  .replace(/\b([A-Za-z0-9_.-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL)[A-Za-z0-9_.-]*)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1=[redacted]')
  .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi,'$1[redacted]@');
const safeTail=value=>tail(redact(oneLine(value)));
const decodeUtf8=value=>new TextDecoder('utf-8',{fatal:true}).decode(value||Buffer.alloc(0));

// Reuses the legacy probe isolation policy, without importing Spec Agent or a model.
export function selectTask(raw) {
  return normalizeTask(raw);
}

export function selectPlan(raw) {
  const task = selectTask(raw);
  check(raw.probes?.length > 0 && raw.probes.length <= 25, 'Probe budget exceeded');
  for(const probe of raw.probes) validateProbe(probe,task);
  const ids = [...raw.documents, ...raw.probes].map(x => x.id);
  check(new Set(ids).size === ids.length, 'Duplicate evidence IDs');
  check(Array.isArray(raw.features) && raw.features.length > 0 && raw.features.length <= 25, 'Feature inventory required');
  for (const f of raw.features) {
    check(typeof f.description === 'string' && f.description.trim() && Array.isArray(f.document_ids) && Array.isArray(f.observation_ids), 'Invalid feature');
    check(f.document_ids.every(id => raw.documents.some(d => d.id === id)) && f.observation_ids.every(id => raw.probes.some(p => p.id === id)), 'Unknown evidence reference');
  }
  // Deliberately omit old issue/specs, candidate outputs and official validation answers.
  return {...task,
    probes: raw.probes.map(({id,argv,stdin,file_text}) => ({id,argv,stdin,...(file_text!==undefined?{file_text}:{})})),
    features: raw.features.map(({id,description,document_ids,observation_ids}) => ({id,description,document_ids,observation_ids}))};
}

function runner(plan, execute) {
  const options = {windowsHide:true, timeout:20000, maxBuffer:256*1024};
  const decode = value => new TextDecoder('utf-8', {fatal:true}).decode(value || Buffer.alloc(0));
  const info = execute('docker', ['image','inspect',plan.image,'--format','{{.Os}}/{{.Architecture}}'], options);
  check(!info.error && info.status === 0 && textOf(info.stdout).trim() === 'linux/amd64',
    `Pinned reference image not available${info.error?` (${info.error.message})`:''}${info.stderr?`: ${safeTail(textOf(info.stderr))}`:''}`);
  const records = [];
  // The HTTP driver configuration is built from the validated task contract, so an
  // execution never forwards whatever extra keys a plan happened to carry.
  const driverConfig = plan.profile === 'service-http/v1' ? serviceDriverConfig(plan) : undefined;
  // Every probe runs a fresh container with the same isolation flags. Only the
  // entrypoint differs:
  //  - service/http or adapter: a fixed trusted driver, never model text;
  //  - CLI probe that references declared read-only resources: run the program
  //    directly against those paths (stdin carries either the documented text
  //    input or nothing at all);
  //  - file probe with the writable fixture: a fixed prelude copies the bytes from
  //    stdin into WRITABLE_FILE, then execs the program with stdin closed. Fixture
  //    content is only ever stdin data, never shell source and never an argument.
  function invoke(executable, argv, stdin = '',fileText,serviceProbe=false) {
    const writesFixture=fileText!==undefined;
    check(!writesFixture || typeof fileText==='string','Invalid text file fixture');
    check(!serviceProbe || typeof stdin==='string','Invalid HTTP probe request');
    const name = `requirements-probe-${randomUUID()}`;
    const args = ['run','--rm','-i','--name',name,'--platform','linux/amd64','--network','none','--read-only','--user','65534:65534',
      '--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','64','--memory','256m','--cpus','1',
      '--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--workdir','/tmp','--env','LANG=C.UTF-8','--env','LC_ALL=C.UTF-8','--env','TZ=UTC',
      '--entrypoint',serviceProbe?driverConfig.runtime:writesFixture?'/bin/sh':executable,plan.image,...(serviceProbe?
        ['-c',httpDriver,JSON.stringify(driverConfig)]:writesFixture?
        ['-c',`umask 077; cat > ${WRITABLE_FILE} || exit 125; exec "$@" < /dev/null`,'fixture',executable,...argv]:
        argv)];
    let result;
    try { result = execute('docker',args,{...options,input:Buffer.from(fileText??stdin)}); }
    finally {
      const cleanup = execute('docker',['rm','-f',name],options);
      check(!cleanup.error && (cleanup.status === 0 || decode(cleanup.stderr).includes('No such container')), 'Probe cleanup failed');
    }
    const rawOut=Buffer.from(result.stdout || []),rawErr=Buffer.from(result.stderr || []);
    const display=b=>{try{return decode(b);}catch{return '[非 UTF-8 字节，见 raw_bytes.base64]';}};
    if(result.error || result.signal != null || !Number.isInteger(result.status) || [125,126,127,137,143].includes(result.status)) {
      const reason=display(rawErr).trim()||display(rawOut).trim()||result.error?.message||'no diagnostic output';
      const httpStartupTimeout=serviceProbe && /startup timed out|启动超时/i.test(reason);
      const httpExited=serviceProbe && /exited before accepting a request|提前退出/i.test(reason);
      const kind=result.error?.code==='ETIMEDOUT'?'执行超时':
        result.status===137||result.status===143?'容器被终止（可能 OOM/信号）':
        httpStartupTimeout?'HTTP 服务启动超时':
        httpExited?'HTTP 服务启动失败（提前退出）':
        result.status===125?'执行器/探测器启动失败':
        result.status===126||result.status===127?'程序或解释器不可执行/未找到':'执行失败';
      throw Error(`${kind}（exit ${result.status ?? 'null'}${result.signal?`, signal ${result.signal}`:''}）：${safeTail(reason)}；这不是程序行为证据`);
    }
    const value = {stdout:display(rawOut),stderr:display(rawErr),exit_code:result.status,
      raw_bytes:{stdout_base64:rawOut.toString('base64'),stderr_base64:rawErr.toString('base64')}};
    records.push({executable,argv,stdin,...(fileText!==undefined?{file_text:fileText}:{}),...value});
    return value;
  }
  return {invoke,records};
}

function readPublicDocuments(plan, invoke) {
  return plan.documents.map(({id,path,text}) => {
    if(text!==undefined) return {id,text,sha256:hash(text)};
    let result;
    try {result = invoke('/bin/cat',[path]);}
    catch(error) {throw Error(`Public document read failed for ${path}: ${error.message}`);}
    check(result.exit_code === 0,
      `Public document read failed for ${path} (exit ${result.exit_code}): ${safeTail(result.stderr || result.stdout || 'no output')}`);
    let decoded;
    try {
      decoded=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(result.raw_bytes?.stdout_base64 || '','base64'));
    } catch {
      throw Error(`Public document is not valid UTF-8: ${path}; provide a UTF-8 text document or inline text`);
    }
    check(decoded.trim(),`Public document is empty: ${path}`);
    return {id,text:decoded,sha256:hash(decoded)};
  });
}

export function readDocuments(raw, execute = spawnSync) {
  const task = selectTask(raw);
  const {invoke,records} = runner(task,execute);
  return {task,documents:readPublicDocuments(task,invoke),records};
}

export function collect(raw, execute = spawnSync) {
  const plan = selectPlan(raw);
  const {invoke,records} = runner(plan,execute);
  const documents = readPublicDocuments(plan,invoke);
  const observations = plan.probes.map(probe => {
    const first = invoke(plan.executable,probe.argv,probe.stdin,probe.file_text,plan.profile==='service-http/v1');
    const second = invoke(plan.executable,probe.argv,probe.stdin,probe.file_text,plan.profile==='service-http/v1');
    let unsupported=false;
    if(plan.profile==='adapter-json/v1') {
      for(const result of [first,second]) {
        let stdout;
        try {
          stdout=decodeUtf8(Buffer.from(result.raw_bytes?.stdout_base64 || '','base64'));
        } catch {
          throw Error(`Adapter output is not valid UTF-8 for ${probe.id} (exit ${result.exit_code}); provide a UTF-8 JSON envelope`);
        }
        let envelope;
        try {envelope=JSON.parse(stdout);}
        catch(error) {
          throw Error(`Adapter returned non-JSON output for ${probe.id} (exit ${result.exit_code}): ${safeTail(stdout)||'<empty output>'}; ${error.message}`);
        }
        check(envelope?.version==='blackbox-adapter/v1' && ['observed','unsupported'].includes(envelope.status) &&
          (envelope.status==='observed'?Object.hasOwn(envelope,'result'):typeof envelope.reason==='string' && envelope.reason.trim()),
          `Invalid adapter observation envelope for ${probe.id}${envelope?.version?` (version ${safeTail(String(envelope.version))})`:''}`);
        unsupported ||= envelope.status==='unsupported';
      }
    }
    const value = {...probe,...first,...(unsupported?{unsupported:true}:{}),
      ...(JSON.stringify(first)!==JSON.stringify(second)?{repeat_result:second}:{})};
    return {...value,sha256:hash(value)};
  });
  const input = {task_id:plan.task_id,scope:plan.scope,documents,observations,features:plan.features,
    interaction:{profile:plan.profile},
    unexplored:['本次仅覆盖任务声明的交互方式和实际输入。','有限探测未证明所有输入；文档与观察矛盾时需单列确认',
      ...observations.filter(o=>o.repeat_result).map(o=>`${o.id} 两次运行结果不同，均已保留；不能据此归纳为稳定规则。`),
      ...observations.filter(o=>o.unsupported).map(o=>`${o.id} 适配器不支持此次操作，没有观察到目标程序行为。`)]};
  return {input,provenance:{plan,plan_sha256:hash(plan),input_sha256:hash(input),records,
    official_answers_supplied:false,spec_candidate_supplied:false,repeats:2,
    inventory_origin:'人工维护的探索功能分类；输入输出来自本次实际运行，不是自动穷尽需求'}};
}
