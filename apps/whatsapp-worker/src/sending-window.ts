const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface LocalClock {
  dayOfWeek: number;
  minutes: number;
}

export function localClock(date: Date, timezone: string): LocalClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    dayOfWeek: weekdays[values.weekday ?? ''] ?? 0,
    minutes: Number(values.hour ?? 0) * 60 + Number(values.minute ?? 0),
  };
}

export function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

export function isInsideWindow(now: LocalClock, window: { day_of_week: number; start_time: string | null; end_time: string | null; enabled: boolean }): boolean {
  if (!window.enabled || window.day_of_week !== now.dayOfWeek || !window.start_time || !window.end_time) return false;
  const start = timeToMinutes(window.start_time);
  const end = timeToMinutes(window.end_time);
  return start <= end ? now.minutes >= start && now.minutes < end : now.minutes >= start || now.minutes < end;
}
