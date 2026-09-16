import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsEmail, MinLength } from 'class-validator';
import { RateLimit } from '../common/rate-limit.decorator';
import { RateLimitGuard } from '../common/rate-limit.guard';
import { AuthService } from './auth.service';

class LoginDto {
  @IsEmail()
  email!: string;

  @MinLength(8)
  password!: string;
}

@UseGuards(RateLimitGuard)
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // 10/min por IP: margen para que alguien reintente una contraseña
  // mal tipeada sin abrir la puerta a fuerza bruta.
  @RateLimit(10, 60_000)
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  // Más estricto que login: registrar cuentas en loop es el abuso más
  // barato de hacer y el menos necesario permitir a este ritmo.
  @RateLimit(5, 60_000)
  @Post('register')
  register(@Body() dto: LoginDto) {
    return this.auth.register(dto.email, dto.password);
  }
}
