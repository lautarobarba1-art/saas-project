import { IsISO8601, IsString, IsUUID, Matches, MinLength } from 'class-validator';

export class CreateManualBookingDto {
  @IsUUID()
  resourceId!: string;

  @IsISO8601()
  startAt!: string;

  @IsISO8601()
  endAt!: string;

  @IsString()
  @MinLength(2)
  clientName!: string;

  @IsString()
  @Matches(/^\+?[0-9\s-]{6,20}$/)
  clientPhone!: string;
}
