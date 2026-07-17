import { describe, expect, it } from 'vitest';
import { localDateKey, normalizePhoneNumber, renderTemplate } from './index.js';

describe('normalizePhoneNumber', () => {
  it('adiciona o codigo do Brasil a um numero nacional', () => {
    expect(normalizePhoneNumber('(27) 98141-6770')).toBe('5527981416770');
  });

  it('preserva um numero E.164 sem o sinal de mais', () => {
    expect(normalizePhoneNumber('+5527981416770')).toBe('5527981416770');
  });

  it('rejeita numeros curtos', () => {
    expect(() => normalizePhoneNumber('123')).toThrow('Numero de telefone invalido');
  });
});

describe('renderTemplate', () => {
  it('substitui variaveis e trata valores ausentes', () => {
    expect(renderTemplate('Ola {{ nome }} - {{cidade}}', { nome: 'Ana' })).toBe('Ola Ana - ');
  });
});

describe('localDateKey', () => {
  it('respeita o fuso do tenant', () => {
    expect(localDateKey(new Date('2026-07-17T01:30:00Z'), 'America/Sao_Paulo')).toBe('2026-07-16');
  });
});
