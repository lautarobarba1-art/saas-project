import { describe, expect, it } from 'vitest';
import { subtractBusy, type Interval } from '../src/bookings/bookings.service';

function iv(startHour: number, endHour: number): Interval {
  const day = '2026-09-21'; // lunes, arbitrario
  return {
    start: new Date(`${day}T${String(startHour).padStart(2, '0')}:00:00-03:00`),
    end: new Date(`${day}T${String(endHour).padStart(2, '0')}:00:00-03:00`),
  };
}

describe('subtractBusy', () => {
  it('sin reservas ocupadas, devuelve la ventana completa sin tocar', () => {
    const base = iv(9, 22);
    expect(subtractBusy(base, [])).toEqual([base]);
  });

  it('una reserva que cubre toda la ventana la deja vacía', () => {
    const base = iv(9, 22);
    expect(subtractBusy(base, [iv(8, 23)])).toEqual([]);
  });

  it('una reserva en el medio parte la ventana en dos huecos', () => {
    const base = iv(9, 22);
    const result = subtractBusy(base, [iv(13, 14)]);
    expect(result).toEqual([iv(9, 13), iv(14, 22)]);
  });

  it('una reserva al principio deja solo el resto', () => {
    const base = iv(9, 22);
    expect(subtractBusy(base, [iv(9, 11)])).toEqual([iv(11, 22)]);
  });

  it('una reserva al final deja solo el comienzo', () => {
    const base = iv(9, 22);
    expect(subtractBusy(base, [iv(20, 22)])).toEqual([iv(9, 20)]);
  });

  it('una reserva fuera de la ventana no le hace nada', () => {
    const base = iv(9, 22);
    expect(subtractBusy(base, [iv(0, 8)])).toEqual([base]);
  });

  it('una reserva que solo toca el borde (sin superposición real) no recorta nada', () => {
    const base = iv(9, 22);
    // termina justo cuando arranca la ventana — el código usa <=/>=,
    // así que "tocar" no cuenta como solape.
    expect(subtractBusy(base, [iv(7, 9)])).toEqual([base]);
    expect(subtractBusy(base, [iv(22, 23)])).toEqual([base]);
  });

  it('varias reservas se restan todas, en cualquier orden', () => {
    const base = iv(9, 22);
    const result = subtractBusy(base, [iv(12, 13), iv(18, 19), iv(9, 10)]);
    expect(result).toEqual([iv(10, 12), iv(13, 18), iv(19, 22)]);
  });
});
