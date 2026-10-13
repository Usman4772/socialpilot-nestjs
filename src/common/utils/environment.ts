export function isDevelopment(): boolean {
  return process.env.ENVIRONMENT === 'development';
}
