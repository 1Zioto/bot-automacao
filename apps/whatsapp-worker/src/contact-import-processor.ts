import type { Job } from 'bullmq';
import { contactImportJobSchema, type ContactImportJob } from '@autoflow/queue';
import type { InstanceManager } from './instance-manager.js';

export function createContactImportProcessor(manager: InstanceManager) {
  return async (job: Job<ContactImportJob>) => {
    const input = contactImportJobSchema.parse(job.data);
    await job.updateProgress({ phase: 'READING', processed: 0 });
    return manager.importPhoneContacts(input.instanceId, input.tenantId, input.requestedBy, (processed, total) =>
      job.updateProgress({ phase: 'IMPORTING', processed, total }),
    );
  };
}
