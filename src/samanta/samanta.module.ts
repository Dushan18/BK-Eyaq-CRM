import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { ReservationSupportModule } from '../reservations/reservation-support.module';
import { SamantaConfig } from './samanta.config';
import { SamantaReservationService } from './samanta-reservations';
import { SamantaProvider } from './samanta.provider';
import { SamantaContextService } from './samanta-context.service';
import { SamantaService } from './samanta.service';
import { SamantaController } from './samanta.controller';
import { SamantaAutoService } from './samanta-auto.service';

@Module({
  imports: [MessagingModule, ReservationSupportModule],
  controllers: [SamantaController],
  providers: [
    SamantaConfig,
    SamantaProvider,
    SamantaContextService,
    SamantaService,
    SamantaAutoService,
    SamantaReservationService,
  ],
})
export class SamantaModule {}
