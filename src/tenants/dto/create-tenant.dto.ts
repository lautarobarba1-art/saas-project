import { IsString, Matches, MinLength } from 'class-validator';

export class CreateTenantDto {
  @IsString()
  @MinLength(2)
  name!: string;

  // Se usa en la URL pública (/public/tenants/:slug): minúsculas,
  // números y guiones simples, sin guiones al principio/final.
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  slug!: string;
}
