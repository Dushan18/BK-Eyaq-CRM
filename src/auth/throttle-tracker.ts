import type { ThrottlerGetTrackerFunction } from '@nestjs/throttler';

// El frontend llama a través de su BFF, así que todas las peticiones llegan con
// la IP de ese servidor: limitar solo por IP haría que todos los usuarios
// compartieran el cupo. Se cuenta por IP y por cuenta (email) o enlace de
// recuperación (token). La clave se guarda como hash (generateKey del throttler).
export const byClientAndAccount: ThrottlerGetTrackerFunction = (req) => {
  const body = req.body as { email?: unknown; token?: unknown } | undefined;
  const account =
    typeof body?.email === 'string'
      ? body.email.trim().toLowerCase()
      : typeof body?.token === 'string'
        ? body.token
        : '';

  return `${String(req.ip)}|${account}`;
};
