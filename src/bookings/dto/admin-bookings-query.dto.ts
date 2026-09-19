import { IsIn, IsOptional, IsUUID, Matches } from 'class-validator';

export class AdminBookingsQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;

  @IsOptional()
  @IsUUID()
  resourceId?: string;

  @IsOptional()
  @IsIn(['pending_payment', 'confirmed', 'expired', 'cancelled'])
  status?: string;
}
