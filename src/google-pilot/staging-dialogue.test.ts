import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  STAGING_GREETING, STAGING_RESPONSE_RULES, normalizeStagingSlot,
} from './staging-dialogue.ts';

const now=DateTime.fromISO('2026-11-23T13:30:00',{zone:'America/Tijuana'});

describe('Spanish staging dialogue contract',()=>{
  it('uses Florencia, discloses automation, and never uses the old VVZ brand',()=>{
    expect(STAGING_GREETING).toContain('dentista Florencia');
    expect(STAGING_GREETING).toContain('asistente virtual');
    expect(STAGING_GREETING).toContain('¿En qué puedo ayudarle?');
    expect(STAGING_GREETING).not.toMatch(/VVZ|Smiles/);
    expect(STAGING_RESPONSE_RULES.join(' ')).toContain('15 a 22 palabras');
    expect(STAGING_RESPONSE_RULES.join(' ')).toContain('máximo 24 palabras');
    expect(STAGING_RESPONSE_RULES.join(' ')).toContain('¿Me confirma que desea guardar esta cita de prueba?');
  });

  it.each([
    ['2026-11-25','11:00','2026-11-25','11:00'],
    ['25 de noviembre de 2026','11 de la mañana','2026-11-25','11:00'],
    ['el 25','a las once de la mañana','2026-11-25','11:00'],
    ['25 de noviembre','11','2026-11-25','11:00'],
    ['27','a las diez','2026-11-27','10:00'],
    ['mañana','2 de la tarde','2026-11-24','14:00'],
    ['pasado mañana','a las 2 pm','2026-11-25','14:00'],
    ['2026-11-25','a las 3','2026-11-25','15:00'],
    ['2026-11-25','09:00','2026-11-25','09:00'],
  ])('resolves %s at %s to explicit local slot', (date,time,wantDate,wantTime)=>{
    expect(normalizeStagingSlot(date,time,now)).toEqual({
      status:'ok',date:wantDate,time:wantTime,
    });
  });

  it.each([
    ['25','11 de mayo','need_time'],
    ['25','once y media','need_time'],
    ['25','9:30','invalid_slot'],
    ['25','6 de la mañana','invalid_slot'],
    ['25','','need_time'],
    ['','11 de la mañana','need_date'],
    ['31 de noviembre de 2026','11 de la mañana','invalid_slot'],
    ['20','11:00','need_date'],
    ['2024-11-25','11 de la mañana','ok'],
  ])('does not invent missing or unsupported detail: %s / %s', (date,time,expected)=>{
    expect(normalizeStagingSlot(date,time,now).status).toBe(expected);
  });

  it('does not auto-correct an explicit historical year',()=>{
    const result=normalizeStagingSlot('2024-11-25','11 de la mañana',now);
    expect(result).toEqual({status:'ok',date:'2024-11-25',time:'11:00'});
    // Existing scheduler validates future business limits; the parser must preserve user intent.
  });
});
