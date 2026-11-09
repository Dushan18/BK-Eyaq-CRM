import type { ConfigService } from '@nestjs/config';

// Empty values count as unset, so `KEY=` in .env means "use the default".
export function envValue(config: ConfigService, key: string) {
  const raw = config.get<string | number | boolean>(key);
  const value = raw === undefined || raw === null ? '' : String(raw).trim();
  return value || undefined;
}
// Only "true" or "false": anything else is a configuration mistake, not "off".
export function envFlag(config: ConfigService, key: string, fallback: boolean) {
  const value = envValue(config, key);
  if (value === undefined) return fallback;
  if (!['true', 'false'].includes(value))
    throw new Error(`${key} debe ser true o false`);
  return value === 'true';
}
export function envInteger(
  config: ConfigService,
  key: string,
  fallback: number,
  min: number,
  max: number,
) {
  const raw = envValue(config, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${key} fuera de rango`);
  return value;
}
