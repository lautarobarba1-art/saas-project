import { describe, expect, it } from 'vitest';
import {
  decodeReference,
  encodeReference,
  formatWhenLabel,
  mapOrderStatus,
} from '../src/payments/payments.service';

describe('mapOrderStatus', () => {
  it('processed + accredited es la única combinación aprobada', () => {
    expect(mapOrderStatus({ status: 'processed', status_detail: 'accredited' })).toBe(
      'approved',
    );
  });

  it('processed con cualquier otro detail se trata como rechazado', () => {
    expect(mapOrderStatus({ status: 'processed', status_detail: 'cc_rejected' })).toBe(
      'rejected',
    );
    expect(mapOrderStatus({ status: 'processed' })).toBe('rejected');
  });

  it('cualquier estado que no sea processed queda pendiente', () => {
    expect(mapOrderStatus({ status: 'created' })).toBe('pending');
    expect(mapOrderStatus({ status: 'in_process' })).toBe('pending');
    expect(mapOrderStatus({})).toBe('pending');
  });
});

describe('encodeReference / decodeReference', () => {
  const tenantId = 'd031ecb7-6e1f-4faa-b2a6-46e7d0a284c8';
  const bookingId = '3cebd412-b9aa-4359-90fa-b2a20ea8b766';

  it('el roundtrip recupera exactamente los mismos dos uuids', () => {
    const encoded = encodeReference(tenantId, bookingId);
    expect(encoded).toHaveLength(64);
    expect(decodeReference(encoded)).toEqual([tenantId, bookingId]);
  });

  it('rechaza cualquier string que no tenga exactamente 64 caracteres', () => {
    expect(decodeReference('')).toBeNull();
    expect(decodeReference('demasiado-corto')).toBeNull();
    expect(decodeReference('a'.repeat(65))).toBeNull();
  });
});

describe('formatWhenLabel', () => {
  it('formatea en horario de Argentina, 24hs, con el día capitalizado', () => {
    // 2026-09-21T12:00:00Z = lunes 09:00 en America/Argentina/Buenos_Aires
    const label = formatWhenLabel(new Date('2026-09-21T12:00:00.000Z'));
    expect(label).toMatch(/^Lunes/);
    expect(label).toContain('09:00');
    expect(label).not.toMatch(/[ap]\.?\s?m\.?/i);
  });
});
