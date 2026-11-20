import path from 'node:path';
const check=(v,m)=>{if(!v)throw Error(m);};
const absolute=p=>typeof p==='string' && p.startsWith('/') && p!=='/' && path.posix.normalize(p)===p && !/[\\\x00-\x1f\x7f]/.test(p);

// --- file/workspace probe contract -----------------------------------------
// One model-written fixture slot plus the read-only resources that task.json
// declares. Nothing here is specific to a program: a task only exposes public
// workspace paths it has reviewed, and a probe may reference exactly those.
export const WRITABLE_FILE='/tmp/probe-input';
export const DEFAULT_FILE_BYTES=8192;
export const MAX_FILE_BYTES=65536;
export const MAX_RESOURCES=120;
// Same rule as public documents: never expose official answers, implementation
// sources or VCS data to a probe.
const FORBIDDEN_READ_PATH=/(?:^|\/)(?:eval|tests?|src|\.git)(?:\/|$)/;
const RESERVED_PREFIXES=['/tmp','/proc','/sys','/dev'];
const SENSITIVE_RESOURCE=/(?:^|\/)(?:\.env(?:[./]|$)|\.npmrc|\.netrc|\.git-credentials|\.htpasswd|\.ssh(?:\/|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$)|\.(?:key|pem|p12|pfx|kdbx|jks|keystore)$/i;
const SERVICE_FIELDS=['runtime','port','args','methods','response_headers','startup_seconds'];
const HTTP_METHODS=['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'];

const inReservedPrefix=p=>RESERVED_PREFIXES.some(prefix=>p===prefix || p.startsWith(prefix+'/'));
// A path a probe may read: an absolute in-image file that is not a system or
// temporary path, not answer/source/VCS material and not a secret by name.
const publicResource=p=>absolute(p) && p.length<=4096 && !inReservedPrefix(p) &&
  !FORBIDDEN_READ_PATH.test(p) && !SENSITIVE_RESOURCE.test(p);
const readonlyPath=(p,executable)=>publicResource(p) && p!==executable;

function normalizeResources(value,executable) {
  if(value===undefined) return undefined;
  check(Array.isArray(value) && value.length>0 && value.length<=MAX_RESOURCES,
    `Invalid resources: 1-${MAX_RESOURCES} public workspace paths required`);
  const resources=[],seen=new Set();
  for(const item of value) {
    const entry=typeof item==='string'?{path:item}:item;
    check(entry && typeof entry==='object' && !Array.isArray(entry) &&
      Object.keys(entry).every(key=>key==='path'||key==='size'),'Invalid resource entry: only path and optional size');
    check(typeof entry.path==='string' && readonlyPath(entry.path,executable),
      `Invalid resource path ${entry.path}: it must be an absolute image path outside /tmp, /proc, /sys and /dev, without eval/tests/src/.git segments, secret file names or the program entry`);
    check(entry.size===undefined || (Number.isInteger(entry.size) && entry.size>=0 && entry.size<=2147483647),'Invalid resource size');
    if(seen.has(entry.path)) continue;
    seen.add(entry.path);
    resources.push({path:entry.path,...(entry.size!==undefined?{size:entry.size}:{})});
  }
  return resources;
}

// The declared workspace resources of a task, as plain paths.
export function taskResources(task) {
  return [...new Set((Array.isArray(task?.resources)?task.resources:[])
    .map(item=>typeof item==='string'?item:item?.path).filter(p=>typeof p==='string'))];
}

// Public documents the task already hands to the model. They are frozen public
// files, so a probe may name them as an argument too (e.g. a word-count tool run
// against the project README) without exposing anything new.
export function documentPaths(task) {
  return [...new Set((Array.isArray(task?.documents)?task.documents:[])
    .map(document=>document?.path).filter(p=>typeof p==='string'))];
}

// Everything a probe may read by path: task resources, the policy's explicit
// read-only list and the public document paths. All are author-reviewed and
// frozen in task.json; nothing else is reachable.
export function readonlyResources(task) {
  const declared=Array.isArray(task?.argument_policy?.readonly_paths)?task.argument_policy.readonly_paths:[];
  return [...new Set([...taskResources(task),...declared])];
}

export function probeReadablePaths(task) {
  return [...new Set([...readonlyResources(task),...documentPaths(task)])];
}

// The single place that states what a `cli-text-file/v1` task may read: the
// writable fixture, its byte budget, and the frozen read-only paths.
export function fileInputs(task) {
  if(task?.profile!=='cli-text-file/v1') return undefined;
  const p=task.argument_policy || {};
  return {writable:WRITABLE_FILE,max_bytes:p.max_file_bytes ?? DEFAULT_FILE_BYTES,readonly_paths:probeReadablePaths(task)};
}

function validateReadOnlyPolicy(raw,readonly) {
  const executable=raw.executable;
  if(readonly!==undefined) {
    check(Array.isArray(readonly) && readonly.length>0 && readonly.length<=8 &&
      readonly.every(p=>typeof p==='string') && new Set(readonly).size===readonly.length,
    'Invalid readonly paths: 1-8 unique absolute container paths required');
    for(const entry of readonly) check(readonlyPath(entry,executable),
      `Invalid readonly path ${entry}: it must be an absolute image path outside /tmp, /proc, /sys and /dev, must not be the executable, and must not contain eval/tests/src/.git segments`);
  }
}

// CLI vectors are frozen by the task author, but they may only name the writable
// fixture or paths the task actually exposes; anything else is a policy error.
function validateArgumentVectors(raw,allowed) {
  const p=raw.argument_policy,fileTask=raw.profile==='cli-text-file/v1';
  for(const vector of p.allowed_vectors || []) {
    // A frozen vector that can never satisfy the argument budget would reject every
    // probe that used it, so the contradiction is refused where it is written.
    check(vector.length>=p.min_args && vector.length<=p.max_args,
      `Approved argument vector of ${vector.length} token(s) is outside the task's ${p.min_args}..${p.max_args} argument budget; probes using it could never pass`);
    check(vector.filter(token=>token===WRITABLE_FILE).length<=1,
      `File tasks allow ${WRITABLE_FILE} at most once per approved argument vector`);
    for(const token of vector) if(token.startsWith('/'))
      check(token===WRITABLE_FILE && fileTask || allowed.has(token),
        token==='/tmp' || token.startsWith('/tmp/')?
          `Only ${WRITABLE_FILE} may be written for a probe; other workspace files belong in resources or argument_policy.readonly_paths`:
          `Approved argument vector references undeclared container path ${token}; only declared resources, argument_policy.readonly_paths or public document paths may be named`);
  }
  if(!fileTask) return;
  check(p.allowed_vectors?.length,'File tasks require at least one approved argument vector');
  check(p.allowed_vectors.some(vector=>vector.includes(WRITABLE_FILE) || vector.some(token=>allowed.has(token))),
    `File tasks require at least one approved vector that references ${WRITABLE_FILE}, a declared read-only resource or a public document path`);
}

function normalizeService(service,executable) {
  check(service && typeof service==='object' && !Array.isArray(service) &&
    Object.keys(service).every(key=>SERVICE_FIELDS.includes(key)),'Invalid service settings');
  check(typeof service.runtime==='string' && absolute(service.runtime),'Invalid service runtime');
  check(Number.isInteger(service.port) && service.port>=1024 && service.port<=65535,'Invalid service port');
  check(Array.isArray(service.args) && service.args.length<=16 &&
    service.args.every(a=>typeof a==='string' && !a.includes('\0') && a.length<=1024),'Invalid service arguments');
  check(Array.isArray(service.methods) && service.methods.length>0 &&
    service.methods.every(m=>HTTP_METHODS.includes(m)),'Invalid HTTP methods');
  check(Array.isArray(service.response_headers) && service.response_headers.length<=8 &&
    service.response_headers.every(h=>/^[a-z][a-z0-9-]{0,60}$/.test(h)),'Invalid response headers');
  check(Number.isInteger(service.startup_seconds) && service.startup_seconds>=1 && service.startup_seconds<=8,'Invalid service startup budget');
  return {runtime:service.runtime,port:service.port,args:[...service.args],methods:[...service.methods],
    response_headers:[...service.response_headers],startup_seconds:service.startup_seconds};
}

// The exact configuration the fixed HTTP driver consumes: the program it starts,
// its frozen arguments, the loopback port, the response headers to record and the
// startup budget. Collect builds it here so an execution never depends on
// whatever extra keys a plan happened to carry.
export function serviceDriverConfig(task) {
  check(task?.profile==='service-http/v1','Service driver requires the HTTP profile');
  check(typeof task.executable==='string' && absolute(task.executable),'Unexpected executable');
  return {...normalizeService(task.service,task.executable),executable:task.executable};
}

export function normalizeTask(raw) {
  check(/^[\w.-]+(?:__[\w.-]+)?$/.test(raw?.task_id || ''),'Invalid task ID');
  check(/^(?:[\w][\w./:-]*@sha256:|sha256:)[a-f0-9]{64}$/.test(raw.image || ''),'Pinned reference image required');
  if(raw.benchmark_revision!==undefined) check(/^[a-f0-9]{40}$/.test(raw.benchmark_revision),'Invalid benchmark revision');
  check(absolute(raw.executable),'Unexpected executable');
  check(typeof raw.scope==='string' && raw.scope.trim(),'Explicit scope required');
  check(['cli-stdin/v1','cli-text-file/v1','service-http/v1','adapter-json/v1'].includes(raw.profile),'Unsupported capability profile');
  check(raw.documents?.length>0 && raw.documents.length<=10,'Document budget exceeded');
  check(raw.documents.every(d=>/^DOC-[\w-]+$/.test(d.id) && (d.text!==undefined?
    d.path===undefined && typeof d.text==='string' && d.text.trim() && d.text.length<=100000:
    absolute(d.path) && !FORBIDDEN_READ_PATH.test(d.path) && d.path!==raw.executable)),'Only public document paths or bounded inline documents allowed');
  check(new Set(raw.documents.map(d=>d.id)).size===raw.documents.length,'Duplicate document IDs');
  // Program-agnostic workspace resources: the declarative exposure a task uses so
  // probes can reference reviewed read-only files instead of inventing paths.
  const resources=normalizeResources(raw.resources,raw.executable);
  const p=raw.argument_policy;
  check(p && Object.keys(p).every(k=>['min_args','max_args','allowed_vectors','prefix','arguments','max_file_bytes','readonly_paths'].includes(k)),'Unknown argument policy field');
  check(Number.isInteger(p.max_args) && p.max_args>=0 && p.max_args<=16 &&
    Number.isInteger(p.min_args) && p.min_args>=0 && p.min_args<=p.max_args,'Invalid argument policy');
  check(!p.allowed_vectors || Array.isArray(p.allowed_vectors) && p.allowed_vectors.every(a=>Array.isArray(a)&&a.every(s=>typeof s==='string')),'Invalid vectors');
  check(!p.prefix || Array.isArray(p.prefix)&&p.prefix.every(s=>typeof s==='string'),'Invalid prefix');
  check(!p.arguments || Array.isArray(p.arguments)&&p.arguments.every(x=>x==null || typeof x==='object' && (!x.forbidden || Array.isArray(x.forbidden)&&x.forbidden.every(v=>typeof v==='string'))),'Invalid argument constraints');
  for(const r of p.arguments || []) if(r) {
    check(Object.keys(r).every(k=>['nonempty','no_leading_option','forbidden'].includes(k)),'Unknown argument constraint');
    for(const k of ['nonempty','no_leading_option']) check(r[k]===undefined || typeof r[k]==='boolean','Invalid boolean constraint');
  }
  const fileTask=raw.profile==='cli-text-file/v1';
  const cliTask=fileTask || raw.profile==='cli-stdin/v1';
  if(p.max_file_bytes!==undefined) {
    check(fileTask,'File input budget requires the text file profile');
    check(Number.isInteger(p.max_file_bytes) && p.max_file_bytes>=1 && p.max_file_bytes<=MAX_FILE_BYTES,
      `Invalid file fixture budget: use an integer from 1 to ${MAX_FILE_BYTES}`);
  }
  if(p.readonly_paths!==undefined) check(cliTask,'readonly_paths requires a CLI profile; a service or adapter probe cannot supply paths');
  validateReadOnlyPolicy(raw,p.readonly_paths);
  const allowed=new Set([...(resources || []).map(r=>r.path),...(p.readonly_paths || []),...documentPaths(raw)]);
  validateArgumentVectors(raw,allowed);
  let service;
  if(raw.profile==='service-http/v1') {
    service=normalizeService(raw.service,raw.executable);
    check(p.min_args===0 && p.max_args===0,'HTTP probes cannot override service arguments');
  } else check(raw.service===undefined,'Service settings require HTTP profile');
  let adapter;
  if(raw.profile==='adapter-json/v1') {
    const a=raw.adapter;
    check(a && Object.keys(a).every(k=>['operations','input_description'].includes(k)),'Invalid adapter settings');
    check(Array.isArray(a.operations) && a.operations.length>0 && a.operations.length<=20 && new Set(a.operations).size===a.operations.length && a.operations.every(v=>/^[a-zA-Z][a-zA-Z0-9_-]{0,59}$/.test(v)),'Invalid adapter operations');
    check(typeof a.input_description==='string' && a.input_description.trim() && a.input_description.length<=4000,'Adapter input description required');
    check(p.min_args===0 && p.max_args===0,'Adapter probes cannot override startup arguments');
    adapter=JSON.parse(JSON.stringify(a));
  } else check(raw.adapter===undefined,'Adapter settings require JSON adapter profile');
  let exploration;
  if(raw.exploration!==undefined) {
    const e=raw.exploration;
    check(e && Object.keys(e).every(k=>['max_rounds','max_probes_per_round'].includes(k)) && Number.isInteger(e.max_rounds) && e.max_rounds>=1 && e.max_rounds<=2 && Number.isInteger(e.max_probes_per_round) && e.max_probes_per_round>=1 && e.max_probes_per_round<=8,'Invalid exploration budget');
    exploration={...e};
  }
  // CLI probes read only what the task exposes. Folding declared resources into
  // the frozen policy keeps one canonical list for validation and for the prompt.
  const policy=JSON.parse(JSON.stringify(p));
  if(cliTask && resources?.length)
    policy.readonly_paths=[...new Set([...(policy.readonly_paths || []),...resources.map(r=>r.path)])];
  return {task_id:raw.task_id,...(raw.benchmark_revision!==undefined?{benchmark_revision:raw.benchmark_revision}:{}),image:raw.image,executable:raw.executable,
    scope:raw.scope,profile:raw.profile,argument_policy:policy,
    ...(resources?{resources}:{}),
    ...(service?{service}:{}),
    ...(adapter?{adapter}:{}),
    ...(exploration?{exploration}:{}),
    documents:raw.documents.map(({id,path,text})=>({id,...(text!==undefined?{text}:{path})}))};
}

// One probe is one written fixture plus its argument vector. The model never names
// a path: the fixture always lands in WRITABLE_FILE, and image samples are only
// the frozen read-only resources the task declared.
function validateFileFixture(probe,{max_bytes}) {
  const argv=Array.isArray(probe.argv)?probe.argv:[];
  const usesWritable=argv.includes(WRITABLE_FILE);
  check(probe.stdin==='','Text file probes run with an empty stdin; put the content in file_text');
  if(!usesWritable) {
    check(probe.file_text===undefined,
      `file_text is only used when the approved argument vector references ${WRITABLE_FILE}; image-provided samples are passed by path and need no file_text`);
    return;
  }
  check(typeof probe.file_text==='string',
    `Text file probe must provide file_text for ${WRITABLE_FILE}; an empty string is an empty file, and an omitted file_text is not the same input`);
  const text=probe.file_text;
  check(!text.includes('\0'),
    `File fixture for ${WRITABLE_FILE} contains NUL bytes (binary content); provide UTF-8 text or reference an image-provided binary sample declared in task.json resources`);
  check(Buffer.from(text,'utf8').toString('utf8')===text,
    `File fixture for ${WRITABLE_FILE} is not valid Unicode text; provide UTF-8 text or reference an image-provided binary sample declared in task.json resources`);
  const bytes=Buffer.byteLength(text);
  check(bytes<=max_bytes,
    `File fixture for ${WRITABLE_FILE} is ${bytes} bytes; this task allows at most ${max_bytes} UTF-8 bytes. Keep the fixture small, or reference a larger or binary image sample declared in task.json resources`);
}

// CLI probes may not invent container paths: every absolute argument has to be
// the writable fixture (file profile only) or a path this task already exposes
// (a declared resource, an explicit read-only path or a public document).
function validateProbePaths(task,probe) {
  if(task.profile==='service-http/v1' || task.profile==='adapter-json/v1') return;
  const readable=probeReadablePaths(task);
  const fileTask=task.profile==='cli-text-file/v1';
  for(const token of probe.argv || []) if(token.startsWith('/'))
    check((fileTask && token===WRITABLE_FILE) || readable.includes(token),
      `Probe argument ${token} is not a path this task declares; use one of its declared resources, argument_policy.readonly_paths or public document paths, or pass the input in a documented relative/flag form`);
}

export function validateProbe(probe,task) {
  const p=task.argument_policy,a=probe.argv;
  const files=fileInputs(task);
  if(files) validateFileFixture(probe,files);
  else check(probe.file_text===undefined,'File fixture not supported by this capability profile');
  check(/^OBS-[\w-]+$/.test(probe.id) && Array.isArray(a) && a.length>=p.min_args && a.length<=p.max_args &&
    a.every(v=>typeof v==='string'&&!v.includes('\0')&&Buffer.byteLength(v)<=1024) &&
    typeof probe.stdin==='string'&&Buffer.byteLength(probe.stdin)<=8192,'Probe outside approved scope');
  if(task.profile==='service-http/v1') validateHTTPRequest(probe.stdin,task.service);
  if(task.profile==='adapter-json/v1') {
    let request;
    try {request=JSON.parse(probe.stdin);}
    catch(error) {throw Error(`Adapter request is not valid JSON: ${error.message}`);}
    check(request && !Array.isArray(request) && Object.keys(request).every(k=>['operation','input'].includes(k)) && task.adapter.operations.includes(request.operation) && Object.hasOwn(request,'input'),'Invalid adapter request');
  }
  check(!p.allowed_vectors || p.allowed_vectors.some(v=>JSON.stringify(v)===JSON.stringify(a)),'Arguments outside task policy');
  check(!p.prefix || p.prefix.every((v,i)=>a[i]===v),'Probe outside approved scope: argument prefix mismatch');
  for(const [i,r] of (p.arguments || []).entries()) if(r) {
    check(typeof a[i]==='string' && (!r.nonempty || a[i].length>0) &&
      (!r.no_leading_option || a[i]==='-' || !a[i].startsWith('-')) &&
      (r.forbidden || []).every(s=>!a[i].includes(s)),'Probe outside approved scope');
  }
  validateProbePaths(task,probe);
}

export function validateHTTPRequest(text,service) {
  let r;
  try {r=JSON.parse(text);}
  catch(error) {throw Error(`HTTP request is not valid JSON: ${error.message}`);}
  check(r && !Array.isArray(r) && Object.keys(r).every(k=>['method','path','headers','body'].includes(k)),'Invalid HTTP request fields');
  check(service.methods.includes(r.method) && typeof r.path==='string' && r.path.startsWith('/') && !r.path.startsWith('//') && !/[\x00-\x20\x7f#]/.test(r.path),'HTTP request outside task policy');
  check(r.body===undefined || typeof r.body==='string','HTTP body must be text');
  check(r.headers===undefined || r.headers && !Array.isArray(r.headers) && typeof r.headers==='object' && Object.entries(r.headers).length<=8 && Object.entries(r.headers).every(([k,v])=>
    /^[a-zA-Z][a-zA-Z0-9-]{0,60}$/.test(k) && !['host','connection','content-length','transfer-encoding','upgrade','proxy-authorization','proxy-connection'].includes(k.toLowerCase()) && typeof v==='string' && !/[\x00-\x1f\x7f]/.test(v)),'Invalid HTTP headers');
  return r;
}
