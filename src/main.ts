import 'reflect-metadata';
import express from 'express';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  // bodyParser: false + parser manual abajo: el webhook de WhatsApp
  // (src/whatsapp-bot/) valida X-Hub-Signature-256 con un HMAC sobre
  // los bytes crudos del body — si Nest ya lo parseó a JSON con su
  // body-parser default, esos bytes originales se pierden y no hay
  // forma de recalcular la firma. El `verify` de acá los guarda en
  // `req.rawBody` antes de parsear, para cualquier ruta que los necesite.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  app.use(
    express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true }));

  // Railway antepone más de un hop en X-Forwarded-For (su propio
  // balanceador aparece ahí, y esa IP cambia entre requests) — con
  // trust proxy en un número fijo terminábamos leyendo ese hop variable
  // en vez del cliente real, y el rate limiting nunca acumulaba nada
  // (cada request caía en una IP "distinta"). `true` confía en toda la
  // cadena y toma la entrada más a la izquierda como IP real del
  // cliente, que es la recomendación estándar para PaaS como este.
  app.set('trust proxy', true);

  // El frontend (Next.js) corre en otro dominio y llama a los
  // endpoints públicos directo desde el navegador. Abierto a cualquier
  // origen a propósito: la auth acá es Bearer token en el header, no
  // cookies de sesión, así que un CORS permisivo no habilita CSRF ni
  // comparte credenciales entre sitios — solo permite que la respuesta
  // sea legible desde otro origen.
  app.enableCors();

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
