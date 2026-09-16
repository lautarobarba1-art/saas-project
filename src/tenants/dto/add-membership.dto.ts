import { IsEmail } from 'class-validator';

export class AddMembershipDto {
  // Se suma siempre como 'staff' — subir a alguien a 'owner' es una
  // acción más sensible (puede a su vez agregar/sacar gente) que no
  // tiene endpoint propio todavía, a propósito.
  @IsEmail()
  email!: string;
}
