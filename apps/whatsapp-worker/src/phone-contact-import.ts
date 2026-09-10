import { normalizePhoneNumber } from '@autoflow/shared';

export interface WhatsAppPhoneContact {
  number?: string;
  name?: string;
  pushname?: string;
  shortName?: string;
  isMyContact: boolean;
  isWAContact: boolean;
  isGroup: boolean;
  isMe: boolean;
}

export interface PhoneContactToImport {
  name: string;
  phoneNumber: string;
}

export interface PreparedPhoneContacts {
  contacts: PhoneContactToImport[];
  scanned: number;
  skipped: number;
}

export function preparePhoneContacts(source: WhatsAppPhoneContact[]): PreparedPhoneContacts {
  const contacts = new Map<string, PhoneContactToImport>();
  let skipped = 0;

  for (const contact of source) {
    if (!contact.isMyContact || !contact.isWAContact || contact.isGroup || contact.isMe || !contact.number) {
      skipped += 1;
      continue;
    }

    try {
      const phoneNumber = normalizePhoneNumber(contact.number);
      const name = contact.name?.trim() || contact.shortName?.trim() || contact.pushname?.trim() || phoneNumber;
      const existing = contacts.get(phoneNumber);
      if (!existing || (existing.name === phoneNumber && name !== phoneNumber)) {
        contacts.set(phoneNumber, { name, phoneNumber });
      }
    } catch {
      skipped += 1;
    }
  }

  return { contacts: [...contacts.values()], scanned: source.length, skipped };
}
