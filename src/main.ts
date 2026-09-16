import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Railway antepone más de un hop en X-Forwarded-For (su propio
  // balanceador aparece ahí, y esa IP cambia entre requests) — con
  // trust proxy en un número fijo terminábamos leyendo ese hop variable
  // en vez del cliente real, y el rate limiting nunca acumulaba nada
  // (cada request caía en una IP "distinta"). `true` confía en toda la
  // cadena y toma la entrada más a la izquierda como IP real del
  // cliente, que es la recomendación estándar para PaaS como este.
  app.set('trust proxy', true);

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
