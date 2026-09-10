import { existsSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import whatsappWeb, { type Client as WhatsAppClient, type Message } from 'whatsapp-web.js';
import QRCode from 'qrcode';
import { getEnvironment } from '@autoflow/config';
import { query, transaction } from '@autoflow/database';
import { emitWebhookEvent, type WebhookEventType } from '@autoflow/events';
import { createLogger } from '@autoflow/logger';
import { DistributedLock, getRedis } from '@autoflow/queue';
import { decryptText, encryptText } from '@autoflow/security';
import { maskPhoneNumber, normalizePhoneNumber } from '@autoflow/shared';
import { acceptedFallbackMessageId, extractExternalMessageId, findRecentSentMessageId } from './sent-message-id.js';
import { preparePhoneContacts } from './phone-contact-import.js';

const { Client, LocalAuth } = whatsappWeb;

interface InstanceRow {
  id: string;
  tenant_id: string;
  client_id: string;
  status: string;
  name?: string | null;
}

interface ManagedInstance {
  row: InstanceRow;
  client: WhatsAppClient;
  lock: DistributedLock;
  renewTimer: NodeJS.Timeout;
  heartbeatTimer: NodeJS.Timeout;
  ready: boolean;
}

const logger = createLogger({ name: 'instance-manager' });
const workerId = `${hostname()}-${process.pid}`;
const optOutPattern = /^(sair|parar|stop|cancelar|descadastrar|remover)\b/i;

function resolveBrowserPath(): string | undefined {
  const configured = process.env.CHROME_PATH?.trim();
  if (configured && existsSync(configured)) return configured;

  const candidates = [
    process.platform === 'win32' ? join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
    process.platform === 'win32' ? join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
    process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
    process.platform === 'win32' ? join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe') : undefined,
    process.platform === 'win32' ? join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe') : undefined,
    process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : undefined,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
}

function resolveSessionClientId(row: InstanceRow): string {
  const cleanId = row.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
  return `inst-${cleanId}`;
}

const browserPath = resolveBrowserPath();

async function emitSafely(tenantId: string, type: WebhookEventType, data: unknown): Promise<void> {
  try {
    await emitWebhookEvent(tenantId, type, data);
  } catch (error) {
    logger.warn({ err: error, tenantId, type }, 'Falha ao enfileirar evento');
  }
}

export class InstanceManager {
  private readonly instances = new Map<string, ManagedInstance>();
  private scanTimer: NodeJS.Timeout | undefined;
  private outboundTimer: NodeJS.Timeout | undefined;
  private isProcessingQueued = false;

  start(): void {
    void this.scan().catch((error) => logger.error({ err: error }, 'Falha ao buscar instancias'));
    this.scanTimer = setInterval(
      () => void this.scan().catch((error) => logger.error({ err: error }, 'Falha ao buscar instancias')),
      5_000,
    );
    this.outboundTimer = setInterval(
      () => void this.processQueuedDirect().catch((error) => logger.error({ err: error }, 'Falha ao processar mensagens pendentes')),
      4_000,
    );
  }

  private async processQueuedDirect(): Promise<void> {
    if (this.isProcessingQueued) return;
    this.isProcessingQueued = true;
    try {
      await query(
        `UPDATE campaigns
         SET status = 'RUNNING', started_at = COALESCE(started_at, now()), updated_at = now()
         WHERE status = 'SCHEDULED' AND (scheduled_at IS NULL OR scheduled_at <= now())`,
      );

      for (const [instanceId, managed] of this.instances.entries()) {
        if (!managed.ready) continue;

        // 1. Process direct outbound API messages
        const directMessages = await query<{
          id: string;
          tenant_id: string;
          contact_id: string;
          recipient_phone_snapshot: string;
          content_ciphertext: Buffer;
          content_iv: Buffer;
          content_tag: Buffer;
          idempotency_key: string;
        }>(
          `SELECT id, tenant_id, contact_id, recipient_phone_snapshot, content_ciphertext, content_iv, content_tag, idempotency_key
           FROM messages
           WHERE instance_id = $1 AND direction = 'OUTBOUND' AND status = 'QUEUED'
           ORDER BY created_at ASC
           LIMIT 1`,
          [instanceId],
        );

        if (directMessages[0]) {
          const directMsg = directMessages[0];
          try {
            await query(`UPDATE messages SET status = 'SENDING', updated_at = now() WHERE id = $1`, [directMsg.id]);
            const text = decryptText({
              ciphertext: directMsg.content_ciphertext,
              iv: directMsg.content_iv,
              tag: directMsg.content_tag,
            });
            const externalId = await this.sendText(instanceId, directMsg.recipient_phone_snapshot, text, directMsg.idempotency_key);
            await query(
              `UPDATE messages SET status = 'SENT', external_message_id = $2, sent_at = now(), updated_at = now() WHERE id = $1`,
              [directMsg.id, externalId],
            );
            await emitSafely(directMsg.tenant_id, 'message.sent', {
              id: directMsg.id,
              instanceId,
              contactId: directMsg.contact_id,
              externalMessageId: externalId,
            });
            logger.info({ instanceId, messageId: directMsg.id, phone: directMsg.recipient_phone_snapshot }, 'Mensagem direta da API enviada com sucesso');
          } catch (err: any) {
            logger.warn({ err: err.message, messageId: directMsg.id }, 'Falha ao enviar mensagem direta');
            await query(
              `UPDATE messages SET status = 'FAILED', error_code = 'SEND_FAILED', updated_at = now() WHERE id = $1`,
              [directMsg.id],
            );
          }
        }

        // 2. Process campaign recipients
        const recipients = await query<{
          id: string;
          tenant_id: string;
          campaign_id: string;
          phone_number_snapshot: string;
          rendered_message: string;
          idempotency_key: string;
        }>(
          `SELECT r.id, r.tenant_id, r.campaign_id, r.phone_number_snapshot, r.rendered_message, r.idempotency_key
           FROM campaign_recipients r
           JOIN campaigns c ON c.id = r.campaign_id AND c.tenant_id = r.tenant_id
           WHERE c.instance_id = $1 AND c.status = 'RUNNING'
             AND r.status = 'QUEUED'
           ORDER BY r.created_at ASC
           LIMIT 1`,
          [instanceId],
        );
        const item = recipients[0];
        if (!item) continue;

        try {
          await query(
            `UPDATE campaign_recipients SET status = 'SENDING', updated_at = now() WHERE id = $1`,
            [item.id],
          );
          const externalId = await this.sendText(instanceId, item.phone_number_snapshot, item.rendered_message, item.idempotency_key);
          await query(
            `UPDATE campaign_recipients SET status = 'SENT', sent_at = now(), external_message_id = $2, updated_at = now() WHERE id = $1`,
            [item.id, externalId],
          );
          await query(
            `UPDATE campaigns SET sent_count = sent_count + 1, updated_at = now() WHERE id = $1`,
            [item.campaign_id],
          );
          logger.info({ instanceId, recipientId: item.id, phone: item.phone_number_snapshot }, 'Mensagem de campanha enviada');

          const pending = await query<{ count: number }>(
            `SELECT count(*)::int as count FROM campaign_recipients WHERE campaign_id = $1 AND status IN ('QUEUED', 'SENDING')`,
            [item.campaign_id],
          );
          if (pending[0]?.count === 0) {
            await query(`UPDATE campaigns SET status = 'COMPLETED', completed_at = now(), updated_at = now() WHERE id = $1`, [item.campaign_id]);
            logger.info({ campaignId: item.campaign_id }, 'Campanha concluida com sucesso');
          }
        } catch (err: any) {
          logger.warn({ err: err.message, recipientId: item.id }, 'Falha ao enviar mensagem de campanha');
          await query(
            `UPDATE campaign_recipients SET status = 'FAILED', failed_at = now(), failure_message = $2, updated_at = now() WHERE id = $1`,
            [item.id, String(err.message || 'Falha').slice(0, 500)],
          );
          await query(
            `UPDATE campaigns SET failed_count = failed_count + 1, updated_at = now() WHERE id = $1`,
            [item.campaign_id],
          );
        }
      }
    } catch (e: any) {
      logger.error({ err: e.message }, 'Erro no loop de envio direto');
    } finally {
      this.isProcessingQueued = false;
    }
  }

  hasReadyClient(instanceId: string): boolean {
    return this.instances.get(instanceId)?.ready === true;
  }

  async importPhoneContacts(
    instanceId: string,
    tenantId: string,
    requestedBy: string,
    onProgress?: (processed: number, total: number) => Promise<unknown>,
  ): Promise<{ scanned: number; eligible: number; imported: number; updated: number; skipped: number }> {
    const managed = this.instances.get(instanceId);
    if (!managed || managed.row.tenant_id !== tenantId) throw new Error('Instancia do WhatsApp nao encontrada neste worker.');
    if (!managed.ready) throw new Error('Instancia do WhatsApp ainda nao esta pronta.');

    const prepared = preparePhoneContacts(await managed.client.getContacts());
    let imported = 0;
    let updated = 0;

    await transaction(async (client) => {
      for (const [index, contact] of prepared.contacts.entries()) {
        const result = await client.query<{ id: string; inserted: boolean }>(
          `INSERT INTO contacts
             (tenant_id, instance_id, name, phone_number, consent_status, consent_source, custom_fields)
           VALUES ($1, $2, $3, $4, 'UNKNOWN', 'WHATSAPP_PHONEBOOK', '{}'::jsonb)
           ON CONFLICT (tenant_id, phone_number) DO UPDATE SET
             instance_id = COALESCE(contacts.instance_id, EXCLUDED.instance_id),
             name = CASE
               WHEN contacts.name = contacts.phone_number OR btrim(contacts.name) = '' THEN EXCLUDED.name
               ELSE contacts.name
             END,
             deleted_at = NULL,
             updated_at = now()
           RETURNING id, (xmax = 0) AS inserted`,
          [tenantId, instanceId, contact.name, contact.phoneNumber],
        );
        const row = result.rows[0]!;
        if (row.inserted) {
          imported += 1;
          await client.query(
            `INSERT INTO consent_events
               (tenant_id, contact_id, previous_status, new_status, source, evidence, user_id)
             VALUES ($1, $2, NULL, 'UNKNOWN', 'WHATSAPP_PHONEBOOK', 'Contato salvo na agenda do WhatsApp conectado', $3)`,
            [tenantId, row.id, requestedBy],
          );
        } else {
          updated += 1;
        }
        if (onProgress && ((index + 1) % 25 === 0 || index + 1 === prepared.contacts.length)) {
          await onProgress(index + 1, prepared.contacts.length);
        }
      }
    });

    logger.info({ instanceId, scanned: prepared.scanned, imported, updated }, 'Contatos do celular importados');
    return {
      scanned: prepared.scanned,
      eligible: prepared.contacts.length,
      imported,
      updated,
      skipped: prepared.skipped,
    };
  }

  async sendText(instanceId: string, phoneNumber: string, content: string, idempotencyKey: string): Promise<string> {
    const managed = this.instances.get(instanceId);
    if (!managed?.ready) throw new Error('Instancia nao esta pronta neste worker.');
    const cleanNumber = normalizePhoneNumber(phoneNumber);
    let destination = `${cleanNumber}@c.us`;
    const sentAfter = Math.floor(Date.now() / 1000) - 2;

    // Obter o ID real registrado no WhatsApp para evitar erros com o 9o digito no Brasil
    // e o erro interno "Cannot read properties of undefined (reading 'getChat')"
    try {
      const numberId = await managed.client.getNumberId(cleanNumber);
      if (numberId?._serialized) {
        destination = numberId._serialized;
      } else if (cleanNumber.startsWith('55') && cleanNumber.length === 13) {
        const withoutNine = cleanNumber.slice(0, 4) + cleanNumber.slice(5);
        const altId = await managed.client.getNumberId(withoutNine);
        if (altId?._serialized) destination = altId._serialized;
      } else if (cleanNumber.startsWith('55') && cleanNumber.length === 12) {
        const withNine = cleanNumber.slice(0, 4) + '9' + cleanNumber.slice(4);
        const altId = await managed.client.getNumberId(withNine);
        if (altId?._serialized) destination = altId._serialized;
      }
    } catch (err: any) {
      logger.warn({ instanceId, err: err.message }, 'Nao foi possivel resolver numberId no WhatsApp; tentando envio direto');
    }

    let sent: any;
    try {
      sent = await managed.client.sendMessage(destination, content);
    } catch (err: any) {
      if (err?.message?.includes("'getChat'") || err?.message?.includes('"getChat"')) {
        throw new Error(`Numero ${maskPhoneNumber(phoneNumber)} nao tem WhatsApp ativo ou nao foi encontrado.`);
      }
      throw err;
    }

    const directId = extractExternalMessageId(sent);
    if (directId) return directId;

    // O WhatsApp Web pode aceitar e entregar a mensagem, mas devolver
    // `undefined` enquanto o modelo interno ainda esta sendo consolidado. Se
    // tratarmos isso como falha, o BullMQ repete o job e envia a mesma mensagem
    // novamente. Tentamos recuperar o ID no historico antes de usar o ID
    // idempotente da propria tarefa como confirmacao de aceite.
    const recoveredId = await this.recoverSentMessageId(managed.client, destination, content, sentAfter);
    if (recoveredId) {
      logger.warn({ instanceId }, 'WhatsApp enviou sem retornar o objeto; ID recuperado no historico');
      return recoveredId;
    }

    const fallbackId = acceptedFallbackMessageId(idempotencyKey);
    logger.warn({ instanceId, fallbackId }, 'WhatsApp enviou sem retornar o objeto; envio registrado pela chave idempotente');
    return fallbackId;
  }

  private async recoverSentMessageId(
    client: WhatsAppClient,
    destination: string,
    content: string,
    sentAfter: number,
  ): Promise<string | undefined> {
    for (const delayMs of [200, 600]) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const chat = await client.getChatById(destination);
        const messages = await chat.fetchMessages({ limit: 20 });
        const recoveredId = findRecentSentMessageId(messages, content, sentAfter);
        if (recoveredId) return recoveredId;
      } catch {
        // A mensagem ja foi aceita; uma falha de leitura do historico nao deve
        // transformar o envio em erro nem permitir que a fila o repita.
      }
    }
    return undefined;
  }

  private async scan(): Promise<void> {
    const rows = await query<InstanceRow>(
      `SELECT id, tenant_id, client_id, status, name
       FROM whatsapp_instances
       WHERE deleted_at IS NULL AND status IN (
         'INITIALIZING', 'QR_PENDING', 'AUTHENTICATING', 'RECONNECTING',
         'READY', 'PAUSED', 'DESTROYED'
       )`,
    );
    for (const row of rows) {
      if (row.status === 'PAUSED' || row.status === 'DESTROYED') {
        await this.stopInstance(row.id, row.status === 'DESTROYED');
      } else if (!this.instances.has(row.id)) {
        await this.startInstance(row);
      }
    }
  }

  private async startInstance(row: InstanceRow, attempt = 1): Promise<void> {
    const lock = new DistributedLock(`wa:instance:${row.id}:owner`, 30_000);
    if (!(await lock.acquire())) return;

    const sessionClientId = resolveSessionClientId(row);
    const sessionDir = join(getEnvironment().WHATSAPP_SESSION_PATH, `session-${sessionClientId}`);

    // Se a instância estiver sendo inicializada ou aguardando QR (não autenticada ainda),
    // removemos dados residuais de inicializações abortadas para evitar que o WhatsApp Web
    // tente restaurar uma sessão quebrada e cause erro de contexto destruído.
    if ((row.status === 'INITIALIZING' || row.status === 'QR_PENDING' || attempt > 1) && existsSync(sessionDir)) {
      try {
        rmSync(sessionDir, { recursive: true, force: true });
        logger.info({ instanceId: row.id, sessionDir }, 'Diretório de sessão temporário limpo para inicialização limpa');
      } catch (err) {
        logger.warn({ err, instanceId: row.id }, 'Não foi possível remover diretório de sessão');
      }
    }

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionClientId, dataPath: getEnvironment().WHATSAPP_SESSION_PATH }),
      authTimeoutMs: 60_000,
      puppeteer: {
        headless: getEnvironment().WHATSAPP_HEADLESS,
        executablePath: browserPath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-extensions',
        ],
      },
    });
    const renewTimer = setInterval(async () => {
      if (!(await lock.renew())) await this.stopInstance(row.id, false);
    }, 10_000);
    const heartbeatTimer = setInterval(() => {
      void query(
        `UPDATE whatsapp_instances SET last_heartbeat_at = now(), worker_id = $3, updated_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [row.id, row.tenant_id, workerId],
      );
    }, 15_000);
    const managed: ManagedInstance = { row, client, lock, renewTimer, heartbeatTimer, ready: false };
    this.instances.set(row.id, managed);

    client.on('qr', async (qr: string) => {
      try {
        const dataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 320 });
        try {
          await getRedis().set(`wa:instance:${row.id}:qr`, dataUrl, 'PX', 120_000);
        } catch {}
        await query(
          `UPDATE whatsapp_instances
           SET status = 'QR_PENDING', connection_state = 'UNPAIRED', qr_code = $3, qr_updated_at = now(), updated_at = now()
           WHERE id = $1 AND tenant_id = $2`,
          [row.id, row.tenant_id, dataUrl],
        );
        await emitSafely(row.tenant_id, 'instance.qr_updated', { instanceId: row.id, expiresInSeconds: 120 });
        const terminalQR = await QRCode.toString(qr, { type: 'terminal', small: true });
        console.log(`\n======================================================`);
        console.log(`[INSTANCIA: ${row.name || row.id}] ESCANEIE O QR CODE:`);
        console.log(`======================================================\n`);
        console.log(terminalQR);
        logger.info({ instanceId: row.id }, 'QR atualizado no banco e terminal');
      } catch (error) {
        logger.error({ err: error, instanceId: row.id }, 'Falha ao processar QR code');
      }
    });
    client.on('authenticated', () => {
      void query(
        `UPDATE whatsapp_instances SET status = 'AUTHENTICATING', updated_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [row.id, row.tenant_id],
      );
    });
    client.on('ready', async () => {
      managed.ready = true;
      const phoneNumber = client.info?.wid?.user ?? null;
      try {
        await getRedis().del(`wa:instance:${row.id}:qr`);
      } catch {}
      await query(
        `UPDATE whatsapp_instances
         SET status = 'READY', connection_state = 'CONNECTED', phone_number = $3, qr_code = NULL,
             connected_at = COALESCE(connected_at, now()), last_heartbeat_at = now(),
             worker_id = $4, last_error_code = NULL, last_error_message = NULL, updated_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [row.id, row.tenant_id, phoneNumber, workerId],
      );
      await emitSafely(row.tenant_id, 'instance.ready', { instanceId: row.id, phoneNumber: phoneNumber ? maskPhoneNumber(phoneNumber) : null });
      console.log(`\n======================================================`);
      console.log(`[INSTANCIA: ${row.name || row.id}] CONECTADA COM SUCESSO!`);
      console.log(`Numero conectado: ${phoneNumber}`);
      console.log(`======================================================\n`);
      logger.info({ instanceId: row.id, phoneNumber: phoneNumber ? maskPhoneNumber(phoneNumber) : undefined }, 'Instancia pronta');
    });
    client.on('auth_failure', (message: string) => void this.failInstance(row, 'AUTH_FAILURE', message));
    client.on('disconnected', (reason: string) => {
      void query(
        `UPDATE whatsapp_instances SET status = 'DISCONNECTED', connection_state = 'DISCONNECTED',
                 disconnected_at = now(), last_error_message = $3, updated_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [row.id, row.tenant_id, reason.slice(0, 500)],
      ).then(() => emitSafely(row.tenant_id, 'instance.disconnected', { instanceId: row.id, reason: reason.slice(0, 200) }));
      void this.stopInstance(row.id, false);
    });
    client.on('message', (message: Message) => void this.handleIncoming(row, message));

    await query(
      `UPDATE whatsapp_instances SET status = 'INITIALIZING', worker_id = $3, last_heartbeat_at = now(), updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [row.id, row.tenant_id, workerId],
    );

    client.initialize().catch(async (error: Error) => {
      const isTransient = error.message.includes('Execution context was destroyed') ||
                          error.message.includes('Session closed') ||
                          error.message.includes('Protocol error');
      if (isTransient && attempt < 3) {
        logger.warn({ instanceId: row.id, attempt, err: error.message }, 'Falha transitória na navegação do Chrome. Limpando sessão e tentando novamente...');
        await this.stopInstance(row.id, false);
        try {
          if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return this.startInstance(row, attempt + 1);
      }
      await this.failInstance(row, 'INITIALIZE_FAILED', error.message);
    });
  }

  private async handleIncoming(row: InstanceRow, message: Message): Promise<void> {
    if (message.fromMe || message.from.endsWith('@g.us') || message.from.endsWith('@newsletter') || message.isStatus) return;
    const contact = await message.getContact();
    const rawNumber = contact.number || message.from.replace(/@.+$/, '');
    let phoneNumber: string;
    try {
      phoneNumber = normalizePhoneNumber(rawNumber);
    } catch {
      return;
    }
    const contactRows = await query<{ id: string; consent_status: string }>(
      `INSERT INTO contacts (tenant_id, instance_id, name, phone_number, consent_status, consent_source)
       VALUES ($1, $2, $3, $4, 'UNKNOWN', 'INBOUND_WHATSAPP')
       ON CONFLICT (tenant_id, phone_number) DO UPDATE
         SET name = CASE WHEN contacts.name = contacts.phone_number THEN EXCLUDED.name ELSE contacts.name END,
             updated_at = now()
       RETURNING id, consent_status`,
      [row.tenant_id, row.id, contact.name || contact.pushname || phoneNumber, phoneNumber],
    );
    const contactId = contactRows[0]!.id;
    const encrypted = encryptText(message.body ?? '');
    const insertedMessages = await query<{ id: string }>(
      `INSERT INTO messages
         (tenant_id, instance_id, contact_id, direction, type, status, external_message_id,
          content_ciphertext, content_iv, content_tag, received_at)
       VALUES ($1, $2, $3, 'INBOUND', 'TEXT', 'RECEIVED', $4, $5, $6, $7, now())
       ON CONFLICT (instance_id, external_message_id) DO NOTHING
       RETURNING id`,
      [row.tenant_id, row.id, contactId, message.id._serialized, encrypted.ciphertext, encrypted.iv, encrypted.tag],
    );
    if (insertedMessages[0]) await emitSafely(row.tenant_id, 'message.received', { instanceId: row.id, contactId, messageId: insertedMessages[0].id });
    if (optOutPattern.test(message.body.trim())) {
      await query(
        `UPDATE contacts SET consent_status = 'REVOKED', opted_out_at = now(), updated_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [contactId, row.tenant_id],
      );
      await query(
        `INSERT INTO consent_events (tenant_id, contact_id, previous_status, new_status, source, evidence)
         VALUES ($1, $2, $3, 'REVOKED', 'KEYWORD_OPT_OUT', $4)`,
        [row.tenant_id, contactId, contactRows[0]!.consent_status, message.body.slice(0, 200)],
      );
      await query(
        `UPDATE campaign_recipients SET status = 'SKIPPED', failure_code = 'OPT_OUT', updated_at = now()
         WHERE tenant_id = $1 AND contact_id = $2 AND status IN ('PENDING', 'QUEUED', 'DEFERRED')`,
        [row.tenant_id, contactId],
      );
      await message.reply('Voce foi removido da lista e nao recebera novos envios.');
      await emitSafely(row.tenant_id, 'contact.opted_out', { instanceId: row.id, contactId });
    }
  }

  private async failInstance(row: InstanceRow, code: string, message: string): Promise<void> {
    await query(
      `UPDATE whatsapp_instances SET status = 'ERROR', connection_state = 'ERROR',
              last_error_code = $3, last_error_message = $4, updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [row.id, row.tenant_id, code, message.slice(0, 500)],
    );
    await emitSafely(row.tenant_id, 'instance.error', { instanceId: row.id, code });
    logger.error({ instanceId: row.id, code }, 'Falha de instancia');
    await this.stopInstance(row.id, false);
  }

  async stopInstance(instanceId: string, logout: boolean): Promise<void> {
    const managed = this.instances.get(instanceId);
    if (!managed) return;
    this.instances.delete(instanceId);
    clearInterval(managed.renewTimer);
    clearInterval(managed.heartbeatTimer);
    try {
      if (logout) await managed.client.logout();
      await managed.client.destroy();
    } catch {
      // O lock ainda deve ser liberado mesmo se o Chromium ja tiver encerrado.
    }
    await managed.lock.release();
    await getRedis().del(`wa:instance:${instanceId}:qr`);
  }

  async shutdown(): Promise<void> {
    if (this.scanTimer) clearInterval(this.scanTimer);
    await Promise.all([...this.instances.keys()].map((id) => this.stopInstance(id, false)));
  }
}
