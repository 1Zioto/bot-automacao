import { describe, expect, it } from 'vitest';
import { acceptedFallbackMessageId, extractExternalMessageId, findRecentSentMessageId } from './sent-message-id.js';

describe('sent message id', () => {
  it('extrai o identificador devolvido diretamente pelo WhatsApp', () => {
    expect(extractExternalMessageId({ id: { _serialized: 'true_5511999999999@c.us_ABC' } })).toBe('true_5511999999999@c.us_ABC');
  });

  it('recupera a mensagem enviada mais recente quando sendMessage devolve undefined', () => {
    const messages = [
      { id: { _serialized: 'antiga' }, fromMe: true, body: 'Ola', timestamp: 100 },
      { id: { _serialized: 'outra' }, fromMe: true, body: 'Outro texto', timestamp: 205 },
      { id: { _serialized: 'recente' }, fromMe: true, body: 'Ola', timestamp: 210 },
    ];
    expect(findRecentSentMessageId(messages, 'Ola', 200)).toBe('recente');
  });

  it('gera um identificador estavel para impedir reenvio da mesma tarefa', () => {
    expect(acceptedFallbackMessageId('outbound-12345678')).toBe('accepted:outbound-12345678');
  });
});
