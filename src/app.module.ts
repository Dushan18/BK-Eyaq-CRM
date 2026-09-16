import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { CommonModule } from './common/common.module';
//import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { RestaurantConfigModule } from './restaurant-config/restaurant-config.module';
import { HealthModule } from './health/health.module';
import { CommercialModule } from './commercial/commercial.module';
import { CustomersModule } from './customers/customers.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    AuthModule,
    UsersModule,
    RolesModule,
    CommonModule,
    ConfigModule,
    DatabaseModule,
    RestaurantConfigModule,
    HealthModule,
    CommercialModule,
    CustomersModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
