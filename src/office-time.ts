export const OFFICE_TIME_ZONE = 'America/Tijuana';

// Format from the real system clock; never rely on the model's training-date assumptions.
export function getOfficeDateContext(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: OFFICE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: string): string => {
    const part = parts.find((entry) => entry.type === type);
    if (!part) throw new Error(`Missing office datetime component: ${type}`);
    return part.value;
  };
  const date = `${value('year')}-${value('month')}-${value('day')}`;
  const time = `${value('hour')}:${value('minute')}:${value('second')}`;
  const weekday = new Intl.DateTimeFormat('es-MX', {
    timeZone: OFFICE_TIME_ZONE,
    weekday: 'long',
  }).format(now);
  return `Fecha actual del consultorio: ${date} (${weekday}). Hora local: ${time}. Zona horaria: ${OFFICE_TIME_ZONE}.`;
}
