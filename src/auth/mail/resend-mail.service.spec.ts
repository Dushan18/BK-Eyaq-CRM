/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import type { ConfigService } from '@nestjs/config';

import type { PasswordResetMail } from './mail.service';
import { ResendMailService } from './resend-mail.service';

type TestableResendMailService = ResendMailService & {
  resend: {
    emails: {
      send: jest.Mock;
    };
  };
};

describe('ResendMailService', () => {
  const mail: PasswordResetMail = {
    to: 'user@eyaq.systems',
    firstName: 'Ana <Admin>',
    resetUrl: 'https://crm.eyaq.systems/reset-password?token=abc&source=email',
    expiresInMinutes: 15,
  };

  function createConfig(values: Record<string, string>): ConfigService {
    return {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
  }

  function getSendMock(service: ResendMailService): jest.Mock {
    return jest.spyOn(
      (service as TestableResendMailService).resend.emails,
      'send',
    );
  }

  it('requiere RESEND_API_KEY', () => {
    expect(() => new ResendMailService(createConfig({}))).toThrow(
      'RESEND_API_KEY no está configurada',
    );
  });

  it('envía el correo con el remitente configurado y HTML escapado', async () => {
    const service = new ResendMailService(
      createConfig({
        RESEND_API_KEY: 're_test_key',
        RESEND_FROM_EMAIL: 'EYAQ Systems <no-reply@eyaq.systems>',
      }),
    );
    const send = getSendMock(service);

    send.mockResolvedValue({
      data: { id: 'email-id' },
      error: null,
      headers: null,
    });

    await service.sendPasswordResetEmail(mail);

    expect(send).toHaveBeenCalledWith({
      from: 'EYAQ Systems <no-reply@eyaq.systems>',
      to: mail.to,
      subject: 'Restablece tu contraseña de EYAQ Systems',
      text: expect.stringContaining(mail.resetUrl),
      html: expect.stringContaining('Ana &lt;Admin&gt;'),
    });
    expect(send.mock.calls[0][0].html).toContain('token=abc&amp;source=email');
  });

  it('propaga un fallo controlado cuando Resend rechaza el envío', async () => {
    const service = new ResendMailService(
      createConfig({ RESEND_API_KEY: 're_test_key' }),
    );
    const send = getSendMock(service);

    send.mockResolvedValue({
      data: null,
      error: {
        name: 'validation_error',
        message: 'Invalid from address',
        statusCode: 422,
      },
      headers: null,
    });

    await expect(service.sendPasswordResetEmail(mail)).rejects.toThrow(
      'Resend no pudo enviar el correo de recuperación',
    );
  });
});
