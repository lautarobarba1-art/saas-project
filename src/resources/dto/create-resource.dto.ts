import { IsIn, IsInt, IsString, Min, MinLength } from 'class-validator';

export class CreateResourceDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsIn(['futbol5', 'padel', 'otro'])
  type!: string;

  @IsInt()
  @Min(0)
  senaAmount!: number;
}
