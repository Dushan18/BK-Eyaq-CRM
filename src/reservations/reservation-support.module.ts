import { Module } from '@nestjs/common';
import { ReservationSupportService } from './reservation-support.service';

@Module({
  providers: [ReservationSupportService],
  exports: [ReservationSupportService],
})
export class ReservationSupportModule {}
