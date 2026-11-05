import {
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { InstagramService } from './instagram.service';

@Controller('webhooks/instagram')
export class InstagramController {
  constructor(private readonly service: InstagramService) {}
  @Get()
  @Header('Content-Type', 'text/plain; charset=utf-8')
  verify(
    @Query('hub.mode') mode: unknown,
    @Query('hub.verify_token') token: unknown,
    @Query('hub.challenge') challenge: unknown,
  ) {
    return this.service.verify(mode, token, challenge);
  }
  @Post()
  @HttpCode(200)
  receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature?: string,
  ) {
    return this.service.receive(request.rawBody, signature);
  }
}
