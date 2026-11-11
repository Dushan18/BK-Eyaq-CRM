import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { ReservationRequestsModule } from '../reservation-requests/reservation-requests.module';
import { CustomerNoticeService } from './customer-notice.service';
import { OwnerApprovalConfig } from './owner-approval.config';
import { OwnerApprovalService } from './owner-approval.service';
import { OwnerReplyService } from './owner-replies.service';

// M9.1: reservation requests go to the owner's WhatsApp for approval.
// M9.2: the owner's answers there are applied to them.
// M9.3: the customer is told the owner's decision.
@Module({
  imports: [MessagingModule, ReservationRequestsModule],
  providers: [
    OwnerApprovalConfig,
    OwnerApprovalService,
    OwnerReplyService,
    CustomerNoticeService,
  ],
  exports: [OwnerApprovalService, OwnerReplyService, CustomerNoticeService],
})
export class OwnerApprovalModule {}
