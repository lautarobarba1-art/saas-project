import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

// bcrypt con 12 rounds: balance razonable entre costo de cómputo y
// resistencia a fuerza bruta para este tipo de app. No usar Math.random
// ni hashing hecho a mano — bcrypt ya maneja el salt por vos.
const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string) {
    // Nota: esta query corre sin tenant-context porque login es lo único
    // que necesita mirar la tabla users "global" antes de saber a qué
    // tenant pertenece el usuario. users no tiene RLS por tenant (no le
    // corresponde), así que usar el pool directo acá es correcto, no un
    // atajo — no repliquen este patrón fuera de auth.
    const { rows } = await this.pool.query(
      'select id, password_hash from users where email = $1',
      [email],
    );
    const user = rows[0];

    // Mismo mensaje de error para "no existe" y "contraseña incorrecta":
    // no le des a un atacante pistas sobre qué emails están registrados.
    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas');
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const accessToken = await this.jwt.signAsync({ sub: user.id });
    return { accessToken };
  }

  async register(email: string, password: string) {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    try {
      const { rows } = await this.pool.query(
        'insert into users (email, password_hash) values ($1, $2) returning id',
        [email, passwordHash],
      );
      return { id: rows[0].id };
    } catch (err: any) {
      // 23505 = unique_violation de Postgres (el email ya existe)
      if (err.code === '23505') {
        throw new UnauthorizedException('El email ya está registrado');
      }
      throw err;
    }
  }
}
