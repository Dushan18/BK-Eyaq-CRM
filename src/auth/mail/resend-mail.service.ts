import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

import { MailService, PasswordResetMail } from './mail.service';

@Injectable()
export class ResendMailService extends MailService {
  private readonly resend: Resend;
  private readonly from: string;

  constructor(private readonly configService: ConfigService) {
    super();

    const apiKey = this.configService.get<string>('RESEND_API_KEY')?.trim();

    if (!apiKey) {
      throw new Error('RESEND_API_KEY no está configurada');
    }

    this.resend = new Resend(apiKey);
    this.from =
      this.configService.get<string>('RESEND_FROM_EMAIL')?.trim() ||
      'EYAQ Systems <onboarding@resend.dev>';
  }

  async sendPasswordResetEmail(mail: PasswordResetMail): Promise<void> {
    const safeFirstName = this.escapeHtml(mail.firstName);
    const safeResetUrl = this.escapeHtml(mail.resetUrl);

    const { error } = await this.resend.emails.send({
      from: this.from,
      to: mail.to,
      subject: 'Restablece tu contraseña de EYAQ Systems',
      text: [
        `Hola ${mail.firstName},`,
        '',
        'Recibimos una solicitud para restablecer tu contraseña.',
        `Abre este enlace: ${mail.resetUrl}`,
        '',
        `El enlace vencerá en ${mail.expiresInMinutes} minutos.`,
        'Si no solicitaste este cambio, ignora este correo.',
      ].join('\n'),
      html: `
        <p>Hola ${safeFirstName},</p>
        <p>Recibimos una solicitud para restablecer tu contraseña.</p>
        <p><a href="${safeResetUrl}">Restablecer contraseña</a></p>
        <p>El enlace vencerá en ${mail.expiresInMinutes} minutos.</p>
        <p>Si no solicitaste este cambio, ignora este correo.</p>
      `,
    });

    if (error) {
      throw new Error('Resend no pudo enviar el correo de recuperación');
    }
  }

  private escapeHtml(value: string): string {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    };

    return value.replace(/[&<>"]/g, (character) => entities[character]);
  }
}
