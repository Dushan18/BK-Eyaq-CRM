import {
  Body,
  Headers,
  HttpCode,
  Post,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RoleCode } from '../../generated/prisma/enums';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  AssignConversationDto,
  ConversationMessagesQueryDto,
  ConversationQueryDto,
  MarkConversationReadDto,
  UpdateAssistantPauseDto,
} from './messaging.dto';
import { ConversationsService } from './conversations.service';
import { OutboundMessagesService } from './outbound-messages.service';
import { OutboundMessageDto } from './outbound-message.dto';

@Controller('conversations')
@UseGuards(AccessTokenGuard, RolesGuard)
@Roles(RoleCode.ADMIN, RoleCode.OPERATOR)
export class ConversationsController {
  constructor(
    private readonly service: ConversationsService,
    private readonly outbound: OutboundMessagesService,
  ) {}
  @Post(':id/messages')
  @HttpCode(202)
  send(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: OutboundMessageDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.outbound.queueOutboundMessage(id, actor.id, key, dto);
  }
  @Get()
  @Roles(RoleCode.ADMIN, RoleCode.OWNER, RoleCode.OPERATOR)
  findAll(@Query() query: ConversationQueryDto) {
    return this.service.findAll(query);
  }
  @Get(':id')
  @Roles(RoleCode.ADMIN, RoleCode.OWNER, RoleCode.OPERATOR)
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.findOne(id);
  }
  @Get(':id/messages')
  @Roles(RoleCode.ADMIN, RoleCode.OWNER, RoleCode.OPERATOR)
  messages(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: ConversationMessagesQueryDto,
  ) {
    return this.service.messages(id, query);
  }
  @Patch(':id/read')
  read(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: MarkConversationReadDto,
  ) {
    return this.service.markRead(id, dto);
  }
  @Patch(':id/assistant')
  assistant(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateAssistantPauseDto,
  ) {
    return this.service.assistant(id, dto);
  }
  @Patch(':id/assignee')
  assign(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AssignConversationDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.assign(id, dto, actor);
  }
}
