const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseUrl(value: string | undefined): URL | undefined {
  try {
    return value ? new URL(value.trim()) : undefined;
  } catch {
    return undefined;
  }
}

// Con NODE_ENV=production, detiene el arranque si la configuración sigue con
// valores de desarrollo o de ejemplo. Sin esta comprobación, esos errores solo
// aparecen más tarde: el correo de recuperación apunta a localhost o no llega,
// o los tokens se firman con un secreto conocido.
export function assertProductionEnv(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'production') return;

  const problems: string[] = [];

  for (const name of ['JWT_SECRET', 'JWT_REFRESH_SECRET']) {
    const value = env[name]?.trim() ?? '';
    if (value.length < 32 || value.startsWith('reemplazar')) {
      problems.push(
        `${name} debe ser un secreto aleatorio de al menos 32 caracteres`,
      );
    }
  }

  if (env.JWT_SECRET?.trim() && env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
    problems.push('JWT_SECRET y JWT_REFRESH_SECRET deben ser distintos');
  }

  const resetUrl = parseUrl(env.FRONTEND_RESET_PASSWORD_URL);
  if (
    !resetUrl ||
    resetUrl.protocol !== 'https:' ||
    LOCAL_HOSTS.has(resetUrl.hostname)
  ) {
    problems.push(
      'FRONTEND_RESET_PASSWORD_URL debe ser la URL https pública de la pantalla de restablecimiento',
    );
  }

  // Sin RESEND_FROM_EMAIL se usa onboarding@resend.dev, que solo entrega al
  // dueño de la cuenta de Resend.
  const from = env.RESEND_FROM_EMAIL?.trim() ?? '';
  if (!from || /@resend\.dev>?$/i.test(from)) {
    problems.push(
      'RESEND_FROM_EMAIL debe usar un remitente de un dominio verificado en Resend',
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Configuración de producción inválida:\n- ${problems.join('\n- ')}`,
    );
  }
}
