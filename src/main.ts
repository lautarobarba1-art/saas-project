import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Railway (y cualquier PaaS con proxy/load balancer delante) termina
  // la conexión antes de que llegue a la app — sin esto, req.ip siempre
  // devuelve la IP del proxy, no la del cliente real, y el rate limiting
  // por IP terminaría agrupando a todo el mundo en el mismo balde.
  app.set('trust proxy', 1);

  // TEMP DEBUG — remove after checking req.ip behind Railway's proxy.
  app.getHttpAdapter().get('/__debug/ip', (req: any, res: any) => {
    res.json({ ip: req.ip, ips: req.ips, xff: req.headers['x-forwarded-for'] });
  });

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
