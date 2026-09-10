export interface SentMessageLike {
  id?: { _serialized?: string } | null;
  fromMe?: boolean;
  body?: string;
  timestamp?: number;
}

export function extractExternalMessageId(message: SentMessageLike | null | undefined): string | undefined {
  const id = message?.id?._serialized?.trim();
  return id || undefined;
}

export function findRecentSentMessageId(
  messages: readonly SentMessageLike[],
  content: string,
  sentAfter: number,
): string | undefined {
  const match = messages
    .filter((message) => message.fromMe === true && message.body === content && (message.timestamp ?? 0) >= sentAfter)
    .sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0))
    .find((message) => extractExternalMessageId(message));
  return extractExternalMessageId(match);
}

export function acceptedFallbackMessageId(idempotencyKey: string): string {
  return `accepted:${idempotencyKey}`;
}
