import {spawnSync} from 'node:child_process';

export function miningCommandArgs(file,args,env=process.env) {
  const label=env.MINING_EXECUTION_LABEL;
  if(label && !/^devstar-mining-run=[0-9a-f]{32}$/.test(label)) throw Error('Invalid mining execution label');
  // The daemon owns containers, not the docker client process. Tag every
  // preparation/probe container so the outer watchdog can remove it as well.
  return file==='docker' && args[0]==='run' && label?['run','--label',label,...args.slice(1)]:args;
}

export function spawnMiningSync(file,args,options) {
  return spawnSync(file,miningCommandArgs(file,args),options);
}
