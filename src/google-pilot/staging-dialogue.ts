// Spanish-only synthetic staging dialogue: no phone routing or patient details.
import { DateTime } from 'luxon';

// The shared production greeting is deliberately untouched.
export const STAGING_GREETING =
  'Hola, buenos días. Le habla la asistente virtual de la dentista Florencia. ¿En qué puedo ayudarle?' as const;

type SlotOk={status:'ok';date:string;time:string};
type SlotError={status:'need_date'|'need_time'|'invalid_slot';reason:string};
export type NormalizedStagingSlot=SlotOk|SlotError;

const MONTHS:Record<string,number>={
  enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,
  julio:7,agosto:8,septiembre:9,setiembre:9,octubre:10,noviembre:11,diciembre:12,
};
const HOURS:Record<string,number>={
  una:1,uno:1,dos:2,tres:3,cuatro:4,cinco:5,seis:6,siete:7,ocho:8,
  nueve:9,diez:10,once:11,doce:12,trece:13,catorce:14,quince:15,
};
const lower=(s:string)=>s.trim().toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ');

function normalizeDate(value:string,now:DateTime):string|SlotError{
  const input=lower(value);
  const local=now.setZone('America/Tijuana');
  if(!local.isValid) return {status:'invalid_slot',reason:'La fecha actual no es válida'};
  if(/^\d{4}-\d{2}-\d{2}$/.test(input)){
    const d=DateTime.fromISO(input,{zone:'America/Tijuana'});
    return d.isValid&&d.toISODate()===input?input:{status:'invalid_slot',reason:'Fecha inválida'};
  }
  if(/^(?:el |para |para el )?pasado manana$/.test(input))
    return local.plus({days:2}).toISODate()!;
  if(/^(?:el |para |para el )?manana$/.test(input))
    return local.plus({days:1}).toISODate()!;
  if(/^(?:el |para |para el )?hoy$/.test(input))
    return local.toISODate()!;
  // "25 de noviembre [de 2026]" and "el 25"; infer only from the current month
  // when the day is still upcoming. Never silently roll an old date to next year.
  const m=input.match(/^(?:(?:el|para|para el|dia)\s+)?(\d{1,2})(?:\s+de)?(?:\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre))?(?:\s+de)?(?:\s+(20\d{2}))?$/);
  if(!m) return {status:'need_date',reason:'Confirme el día y mes de la cita'};
  const day=Number(m[1]);
  const month=m[2]?MONTHS[m[2]]:local.month;
  const year=m[3]?Number(m[3]):local.year;
  const d=DateTime.fromObject({year,month,day},{zone:'America/Tijuana'});
  if(!d.isValid||d.day!==day||d.month!==month)
    return {status:'invalid_slot',reason:'Fecha inválida'};
  if(!m[2]&&day<local.day)
    return {status:'need_date',reason:'Confirme el mes; el día indicado ya pasó'};
  if(!m[3]&&d.startOf('day')<local.startOf('day'))
    return {status:'need_date',reason:'Confirme el año de esa fecha'};
  return d.toISODate()!;
}

function normalizeTime(value:string):string|SlotError{
  const input=lower(value).replace(/^a\s+las?\s+/,'').trim();
  if(/\b(?:media|cuarto|menos|y\s+\d+|mayo|marzo|junio|julio)\b/.test(input))
    return {status:'need_time',reason:'Diga una hora completa, por ejemplo once de la mañana'};
  const m=input.match(/^([01]?\d|2[0-3]|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince)(?:(?::|\.)([0-5]\d))?(?:\s*(?:(?:de\s+la\s+)?(manana|tarde|noche)|am|pm|en\s+punto))?$/);
  if(!m) return {status:'need_time',reason:'Confirme la hora; por ejemplo, once de la mañana'};
  const token=m[1]??'';
  let hour=HOURS[token]??Number(token);
  const minute=m[2]?Number(m[2]):0;
  const pm=/(?:\btarde\b|\bpm\b)/.test(input);
  const am=/(?:\bmanana\b|\bam\b)/.test(input);
  if(pm && hour<12) hour+=12;
  if(am && hour===12) hour=0;
  // In this test schedule 1, 2, and 3 o'clock are only offered as 13–15 h.
  if(!pm&&!am&&hour>=1&&hour<=3) hour+=12;
  if(minute!==0||hour<9||hour>15)
    return {status:'invalid_slot',reason:'Sólo horarios de 9 a 15, en punto'};
  return `${String(hour).padStart(2,'0')}:00`;
}

export function normalizeStagingSlot(
  dateText:string,timeText:string,now:DateTime=DateTime.now(),
):NormalizedStagingSlot {
  const date=normalizeDate(dateText,now);
  if(typeof date!=='string')return date;
  const time=normalizeTime(timeText);
  if(typeof time!=='string')return time;
  return {status:'ok',date,time};
}

export const STAGING_RESPONSE_RULES=[
  'Habla español mexicano natural. Responde con una frase breve y, si hace falta, una pregunta. Objetivo de 15 a 22 palabras; máximo 24 palabras salvo aviso obligatorio o confirmación de reserva.',
  'Haz como máximo una pregunta por turno. No repitas avisos ni explicaciones de pruebas en cada respuesta.',
  'Menciona la naturaleza técnica de la cita sólo una vez y sin prometer una consulta clínica real.',
  'Si la persona ya dijo día, mes y hora (por ejemplo "el 25 a las 11 de la mañana"), NO vuelvas a pedir la hora.',
  'Si la persona da día y hora en turnos separados, conserva ambos datos de la conversación.',
  'El horario "11 de la mañana" significa 11:00. "2 de la tarde" significa 14:00.',
  'Si falta un dato, pregunta sólo por ese dato. Nunca inventes disponibilidad o reservas.',
  'Cuando la disponibilidad esté confirmada, pide una sola confirmación antes de guardar.',
  'Pregunta naturalmente: “¿Me confirma que desea guardar esta cita de prueba?”',
  'Nunca uses “¿Confirmo esa hora?” ni preguntas en primera persona para pedir consentimiento.',
  'No digas que guardaste una cita salvo que la herramienta devuelva exactamente status=booked.',
] as const;
