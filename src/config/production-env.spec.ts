import { assertProductionEnv } from './production-env';

describe('assertProductionEnv', () => {
  const valid = {
    NODE_ENV: 'production',
    JWT_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    FRONTEND_RESET_PASSWORD_URL: 'https://crm.example.com/reset-password',
    RESEND_FROM_EMAIL: 'EYAQ Systems <no-reply@example.com>',
  };

  it('no exige nada fuera de producción', () => {
    expect(() => assertProductionEnv({})).not.toThrow();
    expect(() =>
      assertProductionEnv({
        ...valid,
        NODE_ENV: 'development',
        JWT_SECRET: '',
      }),
    ).not.toThrow();
  });

  it('acepta una configuración de producción completa', () => {
    expect(() => assertProductionEnv(valid)).not.toThrow();
  });

  it.each([
    ['JWT_SECRET', { JWT_SECRET: 'corto' }],
    [
      'JWT_SECRET',
      { JWT_SECRET: 'reemplazar-por-un-secreto-seguro-de-ejemplo' },
    ],
    ['JWT_REFRESH_SECRET', { JWT_REFRESH_SECRET: undefined }],
    ['deben ser distintos', { JWT_REFRESH_SECRET: 'a'.repeat(48) }],
    ['FRONTEND_RESET_PASSWORD_URL', { FRONTEND_RESET_PASSWORD_URL: undefined }],
    [
      'FRONTEND_RESET_PASSWORD_URL',
      { FRONTEND_RESET_PASSWORD_URL: 'http://crm.example.com/reset-password' },
    ],
    [
      'FRONTEND_RESET_PASSWORD_URL',
      { FRONTEND_RESET_PASSWORD_URL: 'https://localhost:5173/reset-password' },
    ],
    ['RESEND_FROM_EMAIL', { RESEND_FROM_EMAIL: undefined }],
    [
      'RESEND_FROM_EMAIL',
      { RESEND_FROM_EMAIL: 'EYAQ Systems <onboarding@resend.dev>' },
    ],
  ])('rechaza el arranque si falla %s', (problem, override) => {
    expect(() => assertProductionEnv({ ...valid, ...override })).toThrow(
      problem,
    );
  });

  it('enumera todos los problemas a la vez', () => {
    expect(() => assertProductionEnv({ NODE_ENV: 'production' })).toThrow(
      /JWT_SECRET[\s\S]*JWT_REFRESH_SECRET[\s\S]*FRONTEND_RESET_PASSWORD_URL[\s\S]*RESEND_FROM_EMAIL/,
    );
  });
});
