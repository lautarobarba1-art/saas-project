import { IsInt, Matches, Max, Min } from 'class-validator';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export class CreateAvailabilityRuleDto {
  // 0 = domingo, igual que day_of_week en db/schema.sql
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @Matches(TIME_PATTERN)
  startTime!: string;

  @Matches(TIME_PATTERN)
  endTime!: string;
}
