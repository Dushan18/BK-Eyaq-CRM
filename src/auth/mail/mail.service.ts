export interface PasswordResetMail {
  to: string;
  firstName: string;
  resetUrl: string;
  expiresInMinutes: number;
}

export abstract class MailService {
  abstract sendPasswordResetEmail(mail: PasswordResetMail): Promise<void>;
}
