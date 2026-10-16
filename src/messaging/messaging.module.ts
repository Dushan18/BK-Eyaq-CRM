import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { MessagesService } from './messages.service';
import { MessagingTransactionService } from './messaging-transaction.service';
import {
  MessagePreparationService,
  MessageProcessorService,
} from './message-processor.service';
import { MessagingQueueService } from './messaging-queue.service';
import { MessagingOutboxService } from './messaging-outbox.service';
import { WhatsAppTransportModule } from '../whatsapp/whatsapp-transport.module';
import { OutboundMessagesService } from './outbound-messages.service';
import { MessageStatusService } from './message-status.service';

@Module({
  imports: [CustomersModule, WhatsAppTransportModule],
  controllers: [ConversationsController],
  providers: [
    ConversationsService,
    MessagesService,
    MessagingTransactionService,
    MessagePreparationService,
    MessageProcessorService,
    MessagingQueueService,
    MessagingOutboxService,
    OutboundMessagesService,
    MessageStatusService,
  ],
  exports: [MessagesService, MessageStatusService],
})
export class MessagingModule {}
