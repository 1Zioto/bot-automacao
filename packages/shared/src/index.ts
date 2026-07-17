export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function assertNever(value: never): never {
  throw new Error(`Valor nao tratado: ${String(value)}`);
}

export function normalizePhoneNumber(value: string, defaultCountryCode = '55'): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) {
    throw new AppError('INVALID_PHONE', 'Numero de telefone invalido.');
  }
  return digits.length <= 11 ? `${defaultCountryCode}${digits}` : digits;
}

export function maskPhoneNumber(value: string): string {
  if (value.length <= 4) return '****';
  return `${'*'.repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
}

export function renderTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key: string) => {
    const value = values[key];
    return value === null || value === undefined ? '' : String(value);
  });
}

export function localDateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
