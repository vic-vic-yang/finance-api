import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');

  // CORS：从 .env 的 CORS_ORIGINS 读取允许列表（逗号分隔）
  // 另外：任何 http://localhost:* 和 http://127.0.0.1:* 自动放行（本地调试 Flutter web 端口随机）
  // 留空 = 允许全部（仅调试用）
  const corsOrigins = (process.env.CORS_ORIGINS || '').trim();
  const allowList = corsOrigins ? corsOrigins.split(',').map(s => s.trim()) : null;
  app.enableCors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // 同源 / curl / 无 Origin 头
      // 任何本机端口都允许（开发用）
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
      // 没配白名单 = 全放行
      if (!allowList) return cb(null, true);
      // 在白名单里
      if (allowList.includes(origin)) return cb(null, true);
      cb(new Error(`CORS blocked: ${origin}`), false);
    },
    credentials: true,
  });

  // CF Tunnel 在前面做了反代，需要信任代理头（X-Forwarded-For）才能让限流拿到真实 IP
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Server running on http://localhost:${port}/api`);
  console.log(`CORS origins: ${corsOrigins || '(all - debug only)'}`);
}

bootstrap();
