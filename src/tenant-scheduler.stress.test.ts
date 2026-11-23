import {describe,it,expect,vi} from 'vitest';
import {DateTime} from 'luxon';
import {schedulerFromPublishedConfig} from './tenant-scheduler.js';
const idA='11111111-1111-4111-8111-111111111111',idB='22222222-2222-4222-8222-222222222222';
function tenant(id:string,opens='09:00',closes='17:00',closures:Array<{start:string;end:string}>=[]){
 return {businessId:id,businessName:'Test clinic',timezone:'America/Tijuana',demoMode:false,
 config:{version:1,greeting:'Hola',language:'es-MX',tone:'professional',voiceId:null,bookingMode:'calendar',handoffMode:'message',faq:null,notes:null},
 services:[{name:'Consulta',durationMinutes:30,priceCents:null,currency:'MXN'}],
 hours:[{weekday:1,opensAt:opens,closesAt:closes}],closures};
}
const integration={calendarId:'test-calendar',officeEmail:'test@example.com',clientId:'test',clientSecret:'test',refreshToken:'test'};
const clock=()=>DateTime.fromISO('2026-11-23T07:00:00',{zone:'America/Tijuana'});
describe('Step 2 configuration stress',()=>{
 it('isolates 200 parallel tenant availability requests',async()=>{
  const port={freeBusy:vi.fn(async()=>[]),insert:vi.fn(async()=>({id:'test'}))};
  const a=schedulerFromPublishedConfig(tenant(idA,'09:00','12:00',[{start:'2026-11-23T17:00:00Z',end:'2026-11-23T18:00:00Z'}]),idA,port,integration,clock);
  const b=schedulerFromPublishedConfig(tenant(idB,'10:00','14:00',[{start:'2026-11-23T21:00:00Z',end:'2026-11-23T22:00:00Z'}]),idB,port,integration,clock);
  const results=await Promise.all(Array.from({length:200},(_,i)=>(i%2?a:b).availableSlots('consulta','2026-11-23')));
  results.forEach((slots,i)=>expect(slots).toEqual(i%2?['10:00','11:00']:['10:00','11:00','12:00']));
  expect(port.freeBusy).toHaveBeenCalledTimes(200);
  expect(port.insert).not.toHaveBeenCalled();
 });
 it('rejects 1000 wrong-tenant configuration attempts',()=>{
  const port={freeBusy:vi.fn(async()=>[]),insert:vi.fn(async()=>({id:'test'}))};
  const a=tenant(idA);
  for(let i=0;i<1000;i++)expect(()=>schedulerFromPublishedConfig(a,idB,port,integration,clock)).toThrow('Tenant configuration mismatch');
  expect(port.freeBusy).not.toHaveBeenCalled();
 });
 it('fails closed for 100 concurrent calendar outages',async()=>{
  const port={freeBusy:vi.fn(async()=>{throw Error('calendar offline')}),insert:vi.fn(async()=>({id:'test'}))};
  const scheduler=schedulerFromPublishedConfig(tenant(idA),idA,port,integration,clock);
  const outcomes=await Promise.allSettled(Array.from({length:100},()=>scheduler.availableSlots('consulta','2026-11-23')));
  expect(outcomes.every(x=>x.status==='rejected')).toBe(true);
  expect(port.insert).not.toHaveBeenCalled();
 });
 it('rejects malformed and overlapping tenant configuration',()=>{
  const port={freeBusy:vi.fn(async()=>[]),insert:vi.fn(async()=>({id:'test'}))};
  expect(()=>schedulerFromPublishedConfig({...tenant(idA),hours:[{weekday:1,opensAt:'09:00',closesAt:'12:00'},{weekday:1,opensAt:'11:00',closesAt:'13:00'}]},idA,port,integration,clock)).toThrow('Overlapping tenant hours');
  expect(()=>schedulerFromPublishedConfig({...tenant(idA),closures:[{start:'2026-11-23T20:00:00Z',end:'2026-11-23T19:00:00Z'}]},idA,port,integration,clock)).toThrow('Invalid tenant closure');
 });
});
