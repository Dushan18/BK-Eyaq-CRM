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
import { WhatsAppAdapter } from '../whatsapp/whatsapp.adapter';
import { OutboundMessagesService } from './outbound-messages.service';
import { MessageStatusService } from './message-status.service';
import { MessengerTransportModule } from '../messenger/messenger-transport.module';
import { MessengerAdapter } from '../messenger/messenger.adapter';
import { InstagramTransportModule } from '../instagram/instagram-transport.module';
import { InstagramAdapter } from '../instagram/instagram.adapter';
import {
  CHANNEL_TRANSPORTS,
  ChannelTransports,
  type ChannelTransport,
} from './channel-transport';
import { AssistantBridge } from './assistant-bridge';

@Module({
  imports: [
    CustomersModule,
    WhatsAppTransportModule,
    MessengerTransportModule,
    InstagramTransportModule,
  ],
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
    // The only place that lists channels: a new provider only adds its transport here.
    {
      provide: CHANNEL_TRANSPORTS,
      useFactory: (...transports: ChannelTransport[]) => transports,
      inject: [WhatsAppAdapter, MessengerAdapter, InstagramAdapter],
    },
    ChannelTransports,
    AssistantBridge,
  ],
  exports: [
    MessagesService,
    MessageStatusService,
    MessagingTransactionService,
    OutboundMessagesService,
    AssistantBridge,
  ],
})
export class MessagingModule {}
