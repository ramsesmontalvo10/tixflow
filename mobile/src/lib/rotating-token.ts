import { Buffer } from 'buffer';
import nacl from 'tweetnacl';

export const TOKEN_WINDOW_SECONDS = 30;

export interface RotatingToken {
  ticketId: number;
  eventId: number;
  window: number;
  signatureBase64: string;
}

export function decodeRotatingToken(data: string): RotatingToken | null {
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== 'object') return null;

    const token = value as Partial<RotatingToken>;
    if (
      !Number.isSafeInteger(token.ticketId) ||
      (token.ticketId ?? 0) <= 0 ||
      !Number.isSafeInteger(token.eventId) ||
      (token.eventId ?? 0) <= 0 ||
      !Number.isSafeInteger(token.window) ||
      typeof token.signatureBase64 !== 'string'
    ) {
      return null;
    }

    const signature = Buffer.from(token.signatureBase64, 'base64');
    if (signature.length !== nacl.sign.signatureLength) return null;

    return {
      ticketId: token.ticketId!,
      eventId: token.eventId!,
      window: token.window!,
      signatureBase64: token.signatureBase64,
    };
  } catch {
    return null;
  }
}

export function verifyRotatingToken(
  token: RotatingToken,
  publicKeyBase64: string,
  expectedEventId: number,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  try {
    if (token.eventId !== expectedEventId) return false;

    const publicKey = Buffer.from(publicKeyBase64, 'base64');
    const signature = Buffer.from(token.signatureBase64, 'base64');
    if (
      publicKey.length !== nacl.sign.publicKeyLength ||
      signature.length !== nacl.sign.signatureLength
    ) {
      return false;
    }

    const currentWindow = Math.floor(nowSeconds / TOKEN_WINDOW_SECONDS);
    if (Math.abs(token.window - currentWindow) > 1) return false;

    const payload = Buffer.from(
      `${token.ticketId}:${token.eventId}:${token.window}`,
      'utf8',
    );
    return nacl.sign.detached.verify(
      new Uint8Array(payload),
      new Uint8Array(signature),
      new Uint8Array(publicKey),
    );
  } catch {
    return false;
  }
}
