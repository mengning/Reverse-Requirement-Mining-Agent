import {mkdir, open, readFile, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash} from './src/hash.mjs';
import {checkRepository, publicationConfig, publishIssue} from './src/publish.mjs';
import {runMiningProcess} from './src/workflow-lifecycle.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));

function runAgent(instance, output, env, options) {
  return runMiningProcess(env.MINING_PYTHON || 'python',[path.join(root,'official_mining.py'),instance,output],{...options,cwd:root,env});
}

export async function runOfficialPipeline(instance,output,repository,{env=process.env,request=fetch,run=runAgent,signal}={}) {
  signal?.throwIfAborted();
  if(!/^[A-Za-z0-9._-]+__[A-Za-z0-9._-]+\.[0-9a-f]{7,40}$/.test(instance)) throw Error('官方实例标识无效');
  const config=publicationConfig(repository,env);
  output=path.resolve(output);
  await mkdir(path.dirname(output),{recursive:true});
  let lock;
  try {lock=await open(output+'.official-lock','wx');}
  catch(error) {if(error.code==='EEXIST') throw Error('本次运行正在进行，请勿重复执行');throw error;}
  try {
    await checkRepository(config,request);
    let manifest;
    try {manifest=JSON.parse(await readFile(path.join(output,'official-pipeline.json'),'utf8'));}
    catch(error) {if(error.code!=='ENOENT') throw error;}
    if(manifest && (manifest.instance!==instance || manifest.repository!==repository || manifest.url!==config.url))
      throw Error('已有运行材料属于其他程序或仓库');
    if(!manifest) {
      await run(instance,output,env,{signal});
      signal?.throwIfAborted();
      const issue=JSON.parse(await readFile(path.join(output,'issue.json'),'utf8'));
      manifest={instance,repository,url:config.url,issue_sha256:hash(issue)};
      await writeFile(path.join(output,'official-pipeline.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
    }
    const issue=JSON.parse(await readFile(path.join(output,'issue.json'),'utf8'));
    if(hash(issue)!==manifest.issue_sha256) throw Error('工单材料已改变，请核对后重新运行');
    signal?.throwIfAborted();
    return await publishIssue(issue,config,path.join(output,'publication.json'),request);
  } finally {await lock.close();await unlink(output+'.official-lock');}
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [instance,output,repository,...extra]=process.argv.slice(2);
  if(!instance || !output || !repository || extra.length) throw Error('Usage: node official-run.mjs INSTANCE OUTPUT OWNER/REPO');
  const receipt=await runOfficialPipeline(instance,output,repository);
  console.log(`工单已发布：${receipt.issue_url}`);
}
