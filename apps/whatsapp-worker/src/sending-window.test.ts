import { describe, expect, it } from 'vitest';
import { isInsideWindow, localClock } from './sending-window.js';

describe('sending window', () => {
  it('converte o horario usando o fuso do tenant', () => {
    expect(localClock(new Date('2026-07-17T12:00:00Z'), 'America/Sao_Paulo')).toEqual({ dayOfWeek: 5, minutes: 540 });
  });

  it('bloqueia fora da janela', () => {
    expect(isInsideWindow({ dayOfWeek: 5, minutes: 19 * 60 }, { day_of_week: 5, start_time: '08:00:00', end_time: '18:00:00', enabled: true })).toBe(false);
  });
});
