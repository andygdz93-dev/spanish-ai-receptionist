import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import { DentalScheduler, type CalendarPort, type DentalConfig } from './dental-calendar.ts';

const zone = 'America/Tijuana';
const config: DentalConfig = {
  calendarId:'test', officeEmail:'office@example.com', timezone:zone,
  services:{limpieza:60, consulta:30},
  hours:{'1':[['09:00','12:00']], '2':[['09:00','12:00']]},
  clientId:'test',clientSecret:'test',refreshToken:'test'
};
const now = (s='2026-11-23T07:00:00') => () => DateTime.fromISO(s,{zone});
function setup(clock=now(), overrides:Partial<DentalConfig>={}, busy:Array<{start:string;end:string}>=[]) {
  const insert=vi.fn(async () => ({id:'event-1'}));
  const freeBusy=vi.fn(async () => busy);
  const port:CalendarPort={insert,freeBusy};
  return {scheduler:new DentalScheduler({...config,...overrides},port,clock),insert,freeBusy};
}
describe('V1 booking availability regression',()=>{
  it('offers clock-hour starts only, with mandatory service + 15-minute closing buffer',async()=>{
    const {scheduler}=setup();
    expect(await scheduler.availableSlots('limpieza','2026-11-23')).toEqual(['09:00','10:00']);
    expect(await scheduler.availableSlots('consulta','2026-11-23')).toEqual(['09:00','10:00','11:00']);
  });
  it('recognizes limpieza dental as the configured limpieza service',async()=>{
    const {scheduler}=setup();
    expect(await scheduler.availableSlots('limpieza dental','2026-11-23')).toEqual(['09:00','10:00']);
    expect(await scheduler.book({service:'limpieza dental',date:'2026-11-23',time:'10:00',patientName:'Paciente Prueba',phone:'0000000000',confirmed:true})).toMatchObject({status:'booked'});
  });
  it('enforces 60 elapsed minutes minimum lead at exact boundary',async()=>{
    const {scheduler}=setup(now('2026-11-23T08:00:00'));
    expect(await scheduler.availableSlots('consulta','2026-11-23')).toContain('09:00');
    const later=setup(now('2026-11-23T08:00:01'));
    expect(await later.scheduler.availableSlots('consulta','2026-11-23')).not.toContain('09:00');
  });
  it('enforces local 30-calendar-day horizon and rejects past dates',async()=>{
    const {scheduler,freeBusy}=setup();
    expect(await scheduler.availableSlots('consulta','2026-11-22')).toEqual([]);
    expect(await scheduler.availableSlots('consulta','2026-12-29')).toEqual([]);
    expect(freeBusy).not.toHaveBeenCalled();
    const edge=setup(now('2026-11-23T07:00:00'),{hours:{...config.hours,'3':[['09:00','12:00']]}});
    expect(await edge.scheduler.availableSlots('consulta','2026-12-23')).toContain('09:00');
  });
  it('blocks occupied windows including the post-service buffer',async()=>{
    const {scheduler}=setup(now(),{},[{start:'2026-11-23T10:05:00-08:00',end:'2026-11-23T10:15:00-08:00'}]);
    expect(await scheduler.availableSlots('limpieza','2026-11-23')).toEqual([]);
  });
  it('honors configured full-day and partial-day clinic closures',async()=>{
    const full=setup(now(),{closures:[{start:'2026-11-23T00:00:00-08:00',end:'2026-11-24T00:00:00-08:00'}]});
    expect(await full.scheduler.availableSlots('consulta','2026-11-23')).toEqual([]);
    const partial=setup(now(),{closures:[{start:'2026-11-23T09:30:00-08:00',end:'2026-11-23T10:30:00-08:00'}]});
    expect(await partial.scheduler.availableSlots('consulta','2026-11-23')).toEqual(['11:00']);
  });
  it('rejects closed days and missing business hours without inventing availability',async()=>{
    const {scheduler}=setup();
    expect(await scheduler.availableSlots('limpieza','2026-11-25')).toEqual([]);
    expect(await setup(now(),{hours:{}}).scheduler.availableSlots('limpieza','2026-11-23')).toEqual([]);
  });
  it('rechecks availability before insertion and rejects off-hour start',async()=>{
    const {scheduler,insert}=setup();
    expect(await scheduler.book({service:'consulta',date:'2026-11-23',time:'09:30',patientName:'Ana Test',phone:'123',confirmed:true})).toEqual({status:'unavailable'});
    expect(insert).not.toHaveBeenCalled();
  });
  it('fails closed when calendar availability is unavailable',async()=>{
    const port:CalendarPort={freeBusy:async()=>{throw Error('offline')},insert:vi.fn()};
    await expect(new DentalScheduler(config,port,now()).availableSlots('consulta','2026-11-23')).rejects.toThrow('offline');
    expect(port.insert).not.toHaveBeenCalled();
  });
});
