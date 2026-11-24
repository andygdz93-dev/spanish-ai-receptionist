// Asynchronous Calendar RPC: heavy Google SDK and OAuth never run on the voice event loop.
import { Worker } from 'node:worker_threads';

export type CalendarRpcResult = {
  status:string;
  date?:string;
  time?:string;
  testOnly?:boolean;
  realPatientBooking?:false;
  savedInGoogleCalendar?:boolean;
  retainedAfterHangup?:boolean;
};

type ResponseMessage = {
  type:'ready'|'fatal'|'response';
  id?:number;
  result?:CalendarRpcResult;
  elapsedMs?:number;
};
type Pending = {
  resolve:(value:CalendarRpcResult)=>void;
  reject:(error:Error)=>void;
  timer:ReturnType<typeof setTimeout>;
  promise:Promise<CalendarRpcResult>;
};
const TIMEOUT_MS=45000;

export class StagingCalendarRpc {
  private readonly worker:Worker;
  private readonly pending=new Map<number,Pending>();
  private nextId=0;
  private closed=false;
  private fatalError:Error|null=null;

  constructor(){
    this.worker=new Worker(new URL('./staging-calendar-worker.ts',import.meta.url));
    this.worker.on('message',(message:ResponseMessage)=>{
      if(message.type==='ready'){
        console.log('VVS_STAGING_CALENDAR_HELPER_READY');
        return;
      }
      if(message.type==='fatal'){
        this.rejectAll(new Error('Staging Calendar identity/preflight failed'));
        return;
      }
      if(message.type!=='response'||message.id===undefined)return;
      const waiter=this.pending.get(message.id);
      if(!waiter)return;
      clearTimeout(waiter.timer);
      this.pending.delete(message.id);
      console.log('VVS_STAGING_CALENDAR_TOOL_MS',message.elapsedMs??-1);
      waiter.resolve(message.result??{status:'calendar_error'});
    });
    this.worker.on('error',e=>this.rejectAll(new Error('Calendar helper failed: '+e.name)));
    this.worker.on('exit',code=>{
      if(!this.closed)this.rejectAll(new Error('Calendar helper exited unexpectedly: '+code));
    });
  }

  private rejectAll(error:Error){
    this.fatalError=error;
    for(const [id,waiter] of this.pending){
      clearTimeout(waiter.timer);
      this.pending.delete(id);
      waiter.reject(error);
    }
  }

  request(action:'availability'|'book',date:string,time:string,confirmed=false):Promise<CalendarRpcResult>{
    if(this.closed||this.fatalError)return Promise.reject(
      this.fatalError??new Error('Calendar helper already closed'));
    const id=++this.nextId;
    let resolveFn!:(value:CalendarRpcResult)=>void;
    let rejectFn!:(error:Error)=>void;
    const promise=new Promise<CalendarRpcResult>((resolve,reject)=>{
      resolveFn=resolve;rejectFn=reject;
    });
    const timer=setTimeout(()=>{
      this.pending.delete(id);
      rejectFn(new Error('Calendar helper timed out without a verified result'));
    },TIMEOUT_MS);
    this.pending.set(id,{resolve:resolveFn,reject:rejectFn,timer,promise});
    try{
      this.worker.postMessage({id,action,date,time,confirmed});
    }catch(e){
      clearTimeout(timer);
      this.pending.delete(id);
      rejectFn(new Error('Unable to deliver Calendar request: '+(e as Error).name));
    }
    return promise;
  }

  async close():Promise<void>{
    if(this.closed)return;
    this.closed=true;
    // A caller hanging up must NOT interrupt an in-flight Google write.
    // Wait for durable completion or an explicit uncertainty timeout.
    const active=[...this.pending.values()].map(p=>p.promise);
    if(active.length)await Promise.allSettled(active);
    await this.worker.terminate();
  }
}
