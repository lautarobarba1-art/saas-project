import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateResourceDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsIn(['futbol5', 'padel', 'otro'])
  type?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  senaAmount?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
