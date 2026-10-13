import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const httpLogger = new Logger('HTTP');

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();
  res.on('finish', () => {
    const path = (req.originalUrl || req.url || '').split('?')[0];
    httpLogger.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`);
  });
  next();
}
