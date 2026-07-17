import { hostname } from 'node:os';
import { Client, LocalAuth, type Message } from 'whatsapp-web.js';
import QRCode from 'qrcode';
import { getEnvironment } from '@autoflow/config';
import { query } from '@autoflow/database';
import { emitWebhookEvent, type WebhookEventType } from '@autoflow/events';
import { createLogger } from '@autoflow/logger';
import { DistributedLock, getRedis } from '@autoflow/queue';
import { encryptText } from '@autoflow/security';
import { maskPhoneNumber, normalizePhoneNumber } from '@autoflow/shared';

interface InstanceRow {
  id: string;
  tenant_id: string;
  client_id: string;
  status: string;
}

interface ManagedInstance {
  row: InstanceRow;
  client: Client;
  lock: DistributedLock;
  renewTimer: NodeJS.Timeout;
  heartbeatTimer: NodeJS.Timeout;
  ready: boolean;
}

const logger = createLogger({ name: 'instance-manager' });
const workerId = `${hostname()}-${process.pid}`;
const optOutPattern = /^(sair|parar|stop|cancelar|descadastrar|remover)\b/i;

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

  start(): void {
    void this.scan();
    this.scanTimer = setInterval(() => void this.scan(), 5_000);
  }

  hasReadyClient(instanceId: string): boolean {
    return this.instances.get(instanceId)?.ready === true;
  }

  async sendText(instanceId: string, phoneNumber: string, content: string): Promise<string> {
    const managed = this.instances.get(instanceId);
    if (!managed?.ready) throw new Error('Instancia nao esta pronta neste worker.');
    const destination = `${normalizePhoneNumber(phoneNumber)}@c.us`;
    const sent = await managed.client.sendMessage(destination, content);
    return sent.id._serialized;
  }

  private async scan(): Promise<void> {
    const rows = await query<InstanceRow>(
      `SELECT id, tenant_id, client_id, status
       FROM whatsapp_instances
       WHERE deleted_at IS NULL AND status IN ('INITIALIZING', 'RECONNECTING', 'READY', 'PAUSED', 'DESTROYED')`,
    );
    for (const row of rows) {
      if (row.status === 'PAUSED' || row.status === 'DESTROYED') {
        await this.stopInstance(row.id, row.status === 'DESTROYED');
      } else if (!this.instances.has(row.id)) {
        await this.startInstance(row);
      }
    }
  }

  private async startInstance(row: InstanceRow): Promise<void> {
    const lock = new DistributedLock(`wa:instance:${row.id}:owner`, 30_000);
    if (!(await lock.acquire())) return;

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: row.client_id, dataPath: getEnvironment().WHATSAPP_SESSION_PATH }),
      puppeteer: {
        headless: getEnvironment().WHATSAPP_HEADLESS,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
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
      const dataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 320 });
      await getRedis().set(`wa:instance:${row.id}:qr`, dataUrl, 'PX', 120_000);
      await query(
        `UPDATE whatsapp_instances SET status = 'QR_PENDING', connection_state = 'UNPAIRED', updated_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [row.id, row.tenant_id],
      );
      await emitSafely(row.tenant_id, 'instance.qr_updated', { instanceId: row.id, expiresInSeconds: 120 });
      logger.info({ instanceId: row.id }, 'QR atualizado');
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
      await getRedis().del(`wa:instance:${row.id}:qr`);
      await query(
        `UPDATE whatsapp_instances
         SET status = 'READY', connection_state = 'CONNECTED', phone_number = $3,
             connected_at = COALESCE(connected_at, now()), last_heartbeat_at = now(),
             worker_id = $4, last_error_code = NULL, last_error_message = NULL, updated_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [row.id, row.tenant_id, phoneNumber, workerId],
      );
      await emitSafely(row.tenant_id, 'instance.ready', { instanceId: row.id, phoneNumber: phoneNumber ? maskPhoneNumber(phoneNumber) : null });
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
    client.initialize().catch((error: Error) => void this.failInstance(row, 'INITIALIZE_FAILED', error.message));
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
