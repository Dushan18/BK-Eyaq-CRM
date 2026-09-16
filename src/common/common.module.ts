import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { GlobalExceptionFilter } from './filters/global-exception.filter';

@Module({
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class CommonModule {}
