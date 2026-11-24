// Staging-only, manually started process supervisor. No system service registration.
// The DEFAULT invocation validates the command shape and starts no children.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { validateStagingProfile } from './staging-profile.ts';
import { readStagingHealthTarget } from './staging-health-target.ts';

export type SupervisorComponent='drainer'|'monitor';
export function parseSupervisorArgs(args:string[]):{run:boolean;component:SupervisorComponent}{
  if(args.some(x=>!['--validate','--run','--drainer','--monitor'].includes(x)))
    throw new Error('Unrecognized staging supervisor argument');
  if(args.includes('--run')&&args.includes('--validate'))throw new Error('Select run or validate, not both');
  if(args.includes('--drainer')&&args.includes('--monitor'))throw new Error('Select one component per process');
  return {run:args.includes('--run'),component:args.includes('--monitor')?'monitor':'drainer'};
}
async function onceChild(script:string,shouldRun:()=>boolean,env:NodeJS.ProcessEnv):Promise<number|null>{
  return new Promise(resolveResult=>{
    if(!shouldRun()){resolveResult(null);return;}
    const child=spawn(process.execPath,[script,'--once'],{
      cwd:process.cwd(),windowsHide:true,stdio:'inherit',env,
    });
    const close=()=>{if(!child.killed)child.kill();};
    process.on('SIGINT',close);
    process.on('SIGTERM',close);
    child.once('error',()=>{
      process.off('SIGINT',close);process.off('SIGTERM',close);
      resolveResult(null);
    });
    child.once('exit',code=>{
      process.off('SIGINT',close);process.off('SIGTERM',close);
      resolveResult(code);
    });
  });
}
export async function runStagingSupervisor(
  config:{run:boolean;component:SupervisorComponent},
  env:NodeJS.ProcessEnv=process.env,
  projectRoot=process.cwd(),
):Promise<'validated_only'|'stopped'> {
  if(!config.run)return 'validated_only';
  const profile=validateStagingProfile(env,projectRoot);
  if(!profile || !profile.telemetryEnabled)throw new Error('Staging telemetry supervisor requires approved staging with producer enabled');
  if(config.component==='monitor')readStagingHealthTarget(env);
  const file=config.component==='monitor'?'src/telemetry-health.ts':'src/telemetry-drain.ts';
  let running=true;
  const stop=()=>{running=false;};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    while(running){
      const code=await onceChild(file,()=>running,env);
      console.log('staging-supervisor',config.component,'exit_status',code===0?'success':'retry_pending');
      if(!running)break;
      await new Promise(resolveWait=>setTimeout(resolveWait,config.component==='monitor'?30000:5000));
    }
  }finally {
    process.off('SIGINT',stop);process.off('SIGTERM',stop);
  }
  return 'stopped';
}
const direct=process.argv[1] && import.meta.url===new URL('file://'+resolve(process.argv[1]).replaceAll('\\','/')).href;
if(direct){
  try{
    const config=parseSupervisorArgs(process.argv.slice(2));
    if(!config.run)console.log('VALIDATION_ONLY; no service or subprocess started');
    else await runStagingSupervisor(config);
  }catch(error){
    console.error(error instanceof Error?error.message:'Staging supervisor configuration failed');
    process.exitCode=1;
  }
}
