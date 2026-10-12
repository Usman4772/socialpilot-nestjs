import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import {
  isOriginAllowed,
  parseAllowedOrigins,
} from './common/utils/allowed-origins.util';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const configService = app.get(ConfigService);
  const enableSwagger =
    configService.get<string>('ENABLE_SWAGGER', 'true') === 'true';
  if (process.env.NODE_ENV !== 'production' && enableSwagger) {
    const config = new DocumentBuilder()
      .setTitle('Social Hub API')
      .setDescription('Authentication and profile API for Social Hub.')
      .setVersion('1.0')
      .addBearerAuth()
      .addTag('Auth', 'Google sign-in')
      .addTag('Users', 'Signed-in profile')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
      },
    });
  }

  const httpAdapter = app.getHttpAdapter();
  const instance: any = httpAdapter.getInstance?.() ?? (httpAdapter as any).instance;
  if (instance?.disable) {
    instance.disable('etag');
  }

  const allowedOrigins = parseAllowedOrigins(
    configService.get<string>('ALLOWED_ORIGINS'),
    configService.get<string>('FRONTEND_URL'),
  );

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) {
        return callback(null, true);
      }
      if (allowedOrigins.length === 0) {
        return callback(null, true);
      }
      if (isOriginAllowed(origin, allowedOrigins)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin'],
    exposedHeaders: ['Content-Length', 'Content-Type'],
    optionsSuccessStatus: 204,
  });

  await app.listen(process.env.PORT ?? 3040);
}
bootstrap();
