import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { ReservationSupportModule } from '../reservations/reservation-support.module';
import { EmailConfig } from './email.config';
import { EmailImportService } from './email-import.service';
import { ImapMailboxReader, MailboxReader } from './mailbox-reader';
import { WebReservationService } from './web-reservation.service';

@Module({
  imports: [MessagingModule, ReservationSupportModule],
  providers: [
    EmailConfig,
    { provide: MailboxReader, useClass: ImapMailboxReader },
    WebReservationService,
    EmailImportService,
  ],
})
export class EmailModule {}
