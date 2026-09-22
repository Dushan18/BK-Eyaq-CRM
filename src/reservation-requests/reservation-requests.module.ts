import { Module } from '@nestjs/common';
import { ReservationSupportModule } from '../reservations/reservation-support.module';
import { ReservationRequestsService } from './reservation-requests.service';
import { ReservationRequestsController } from './reservation-requests.controller';

@Module({
  imports: [ReservationSupportModule],
  providers: [ReservationRequestsService],
  controllers: [ReservationRequestsController],
  exports: [ReservationRequestsService],
})
export class ReservationRequestsModule {}
