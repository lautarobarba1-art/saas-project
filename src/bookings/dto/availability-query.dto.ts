import { Matches } from 'class-validator';

export class AvailabilityQueryDto {
  // YYYY-MM-DD, sin hora: la disponibilidad se calcula para un día
  // completo en horario de Argentina (ver nota de timezone en el service).
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string;
}
