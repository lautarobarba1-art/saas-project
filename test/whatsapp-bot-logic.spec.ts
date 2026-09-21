import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  extractSlugCandidates,
  verifyWebhookSignature,
} from '../src/whatsapp-bot/whatsapp-bot.service';

describe('verifyWebhookSignature', () => {
  const secret = 'test-app-secret';
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));

  function sign(payload: Buffer, key: string): string {
    return 'sha256=' + createHmac('sha256', key).update(payload).digest('hex');
  }

  it('acepta una firma calculada con el secret correcto', () => {
    expect(verifyWebhookSignature(body, sign(body, secret), secret)).toBe(true);
  });

  it('rechaza una firma calculada con otro secret', () => {
    expect(verifyWebhookSignature(body, sign(body, 'otro-secret'), secret)).toBe(
      false,
    );
  });

  it('rechaza si el body fue modificado después de firmarlo', () => {
    const signature = sign(body, secret);
    const tampered = Buffer.from(JSON.stringify({ hello: 'mundo' }));
    expect(verifyWebhookSignature(tampered, signature, secret)).toBe(false);
  });

  it('rechaza si falta la firma, el secret o el body crudo', () => {
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifyWebhookSignature(body, sign(body, secret), undefined)).toBe(false);
    expect(verifyWebhookSignature(undefined, sign(body, secret), secret)).toBe(false);
  });
});

describe('extractSlugCandidates', () => {
  it('prioriza el tag (ref:slug) del link "Consultanos por WhatsApp"', () => {
    const text = 'Hola! Quiero hacer una consulta sobre Complejo Demo (ref:demo)';
    expect(extractSlugCandidates(text)[0]).toBe('demo');
  });

  it('interpreta el mensaje completo como slug si alguien escribe directo', () => {
    expect(extractSlugCandidates('demo')).toContain('demo');
  });

  it('slugifica un nombre con espacios y mayúsculas como respaldo', () => {
    const candidates = extractSlugCandidates('Complejo Demo');
    expect(candidates).toContain('complejo-demo');
  });

  it('devuelve ambos candidatos cuando hay ref tag, priorizando el ref', () => {
    const candidates = extractSlugCandidates('Consulta sobre Demo (ref:demo)');
    expect(candidates[0]).toBe('demo');
    expect(candidates).toContain('consulta-sobre-demo-ref-demo');
  });
});
