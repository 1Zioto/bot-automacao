import { z } from 'zod';

export const roleSchema = z.enum(['OWNER', 'ADMIN', 'OPERATOR', 'ANALYST']);
export type Role = z.infer<typeof roleSchema>;

export const instanceStateSchema = z.enum([
  'CREATED',
  'INITIALIZING',
  'QR_PENDING',
  'AUTHENTICATING',
  'READY',
  'DISCONNECTED',
  'RECONNECTING',
  'PAUSED',
  'ERROR',
  'DESTROYED',
]);
export type InstanceState = z.infer<typeof instanceStateSchema>;

export const campaignStateSchema = z.enum([
  'DRAFT',
  'SCHEDULED',
  'PREPARING',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'CANCELED',
  'ERROR',
]);
export type CampaignState = z.infer<typeof campaignStateSchema>;

export const consentStatusSchema = z.enum(['UNKNOWN', 'GRANTED', 'REVOKED', 'BLOCKED']);
export type ConsentStatus = z.infer<typeof consentStatusSchema>;

export const registerTenantSchema = z.object({
  companyName: z.string().trim().min(2).max(160),
  document: z.string().trim().max(32).optional(),
  timezone: z.string().trim().default('America/Sao_Paulo'),
  ownerName: z.string().trim().min(2).max(160),
  email: z.email(),
  password: z.string().min(10).max(128),
  acceptedTermsVersion: z.string().min(1),
});

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export const createInstanceSchema = z.object({
  name: z.string().trim().min(2).max(120),
});

export const createContactSchema = z.object({
  name: z.string().trim().min(1).max(160),
  phoneNumber: z.string().min(10).max(24),
  email: z.email().optional(),
  consentStatus: consentStatusSchema,
  consentSource: z.string().trim().min(2).max(160),
  consentAt: z.iso.datetime().optional(),
  consentEvidence: z.string().trim().max(2000).optional(),
  notes: z.string().max(4000).optional(),
  customFields: z.record(z.string(), z.unknown()).default({}),
});

export const createListSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(1000).optional(),
  contactIds: z.array(z.uuid()).max(100_000).default([]),
});

export const createCampaignSchema = z.object({
  name: z.string().trim().min(2).max(160),
  instanceId: z.uuid(),
  listIds: z.array(z.uuid()).min(1).max(100),
  messageTemplate: z.string().trim().min(1).max(4096),
  mediaId: z.uuid().optional(),
  scheduledAt: z.iso.datetime().optional(),
});

export const startCampaignSchema = z.object({
  consentConfirmed: z.literal(true),
});
