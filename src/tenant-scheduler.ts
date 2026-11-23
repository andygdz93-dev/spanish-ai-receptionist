import { z } from 'zod';
import { DateTime } from 'luxon';
import { DentalScheduler, type CalendarPort, type DentalConfig } from './dental-calendar.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const published = z.strictObject({
 businessId:z.string().uuid(),businessName:z.string().min(1),timezone:z.string().min(1),demoMode:z.boolean(),
 config:z.strictObject({version:z.number().int().positive(),greeting:z.string(),language:z.string(),tone:z.string(),voiceId:z.string().nullable(),bookingMode:z.string(),handoffMode:z.string(),faq:z.string().nullable(),notes:z.string().nullable()}),
 services:z.array(z.strictObject({name:z.string().min(1),durationMinutes:z.number().int().min(5).max(480),priceCents:z.number().int().nullable(),currency:z.string()})),
 hours:z.array(z.strictObject({weekday:z.number().int().min(0).max(6),opensAt:hhmm,closesAt:hhmm})),
 closures:z.array(z.strictObject({start:z.string().datetime({offset:true}),end:z.string().datetime({offset:true})}))
});
export type PublishedTenantConfig=z.infer<typeof published>;
export function testClock(iso:string,zone:string):ConstructorParameters<typeof DentalScheduler>[2] {
 const value=DateTime.fromISO(iso,{zone});
 if(!value.isValid)throw Error('Invalid test clock');
 return ()=>value;
}
/** The business ID must come from authenticated call routing, never caller speech. */
export function schedulerFromPublishedConfig(
 input:unknown, authorizedBusinessId:string, calendar:CalendarPort,
 integration:{calendarId:string;officeEmail:string;clientId:string;clientSecret:string;refreshToken:string},
 now?:ConstructorParameters<typeof DentalScheduler>[2]
):DentalScheduler {
 const tenant=published.parse(input);
 if(tenant.businessId!==authorizedBusinessId)throw Error('Tenant configuration mismatch');
 if(tenant.demoMode || tenant.config.bookingMode!=='calendar')throw Error('Calendar booking not enabled for tenant');
 if(!DateTime.now().setZone(tenant.timezone).isValid)throw Error('Invalid tenant timezone');
 if(!integration.calendarId.trim())throw Error('Missing tenant calendar');
 const services:Record<string,number>={};
 for(const s of tenant.services){
  const name=s.name.toLowerCase().trim();
  if(!name || Object.hasOwn(services,name))throw Error('Invalid tenant services');
  services[name]=s.durationMinutes;
 }
 const hours:Record<string,[string,string][]>={};
 for(const h of tenant.hours){
  if(h.opensAt>=h.closesAt)throw Error('Invalid tenant hours');
  (hours[String(h.weekday)]??=[]).push([h.opensAt,h.closesAt]);
 }
 for(const spans of Object.values(hours)){
  spans.sort((a,b)=>a[0].localeCompare(b[0]));
  for(let i=1;i<spans.length;i++)if(spans[i]![0]<spans[i-1]![1])throw Error('Overlapping tenant hours');
 }
 for(const c of tenant.closures){
  const start=DateTime.fromISO(c.start),end=DateTime.fromISO(c.end);
  if(!start.isValid || !end.isValid || end<=start)throw Error('Invalid tenant closure');
 }
 const config:DentalConfig={...integration,timezone:tenant.timezone,services,hours,closures:tenant.closures};
 return new DentalScheduler(config,calendar,now);
}
