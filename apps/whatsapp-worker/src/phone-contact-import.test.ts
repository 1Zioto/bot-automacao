import { describe, expect, it } from 'vitest';
import { preparePhoneContacts, type WhatsAppPhoneContact } from './phone-contact-import.js';

function contact(overrides: Partial<WhatsAppPhoneContact> = {}): WhatsAppPhoneContact {
  return {
    number: '27999999999',
    name: 'Cliente salvo',
    isMyContact: true,
    isWAContact: true,
    isGroup: false,
    isMe: false,
    ...overrides,
  };
}

describe('preparePhoneContacts', () => {
  it('inclui somente contatos salvos e registrados no WhatsApp', () => {
    const result = preparePhoneContacts([
      contact(),
      contact({ number: '27888888888', isMyContact: false }),
      contact({ number: '27777777777', isWAContact: false }),
      contact({ number: '27666666666', isGroup: true }),
    ]);
    expect(result.contacts).toEqual([{ name: 'Cliente salvo', phoneNumber: '5527999999999' }]);
    expect(result.skipped).toBe(3);
  });

  it('remove duplicados e prefere o nome salvo', () => {
    const result = preparePhoneContacts([
      contact({ number: '5527999999999', name: '', pushname: '' }),
      contact({ number: '5527999999999', name: 'Nome da agenda' }),
    ]);
    expect(result.contacts).toEqual([{ name: 'Nome da agenda', phoneNumber: '5527999999999' }]);
  });
});
