import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // whitelist: descarta cualquier campo del body que no esté en el DTO.
  // forbidNonWhitelisted: si mandan un campo extra, rechaza la request
  // en vez de ignorarlo en silencio (evita asunciones incorrectas sobre
  // qué datos está mandando el cliente).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}
bootstrap();
