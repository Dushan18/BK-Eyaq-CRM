import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { ConfigService } from '@nestjs/config';

@Controller()
export class AppController {
  constructor(private readonly configService: ConfigService) {}

  @Get()
  getHello() {
    return {
      //port: this.configService.get('PORT'),
      jwt: this.configService.get('JWT_SECRET'),
    };
  }
}
