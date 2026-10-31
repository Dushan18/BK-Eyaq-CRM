import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RoleCode } from '../../generated/prisma/enums';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { EditDraftDto, GenerateDraftDto, ReviewDraftDto } from './samanta.dto';
import { SamantaService } from './samanta.service';

@Controller('conversations/:id/assistant-drafts')
@UseGuards(AccessTokenGuard, RolesGuard)
@Roles(RoleCode.ADMIN, RoleCode.OPERATOR)
export class SamantaController {
  constructor(private readonly service: SamantaService) {}
  @Post()
  generate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: GenerateDraftDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.generate(id, actor, key, dto);
  }
  @Get()
  @Roles(RoleCode.ADMIN, RoleCode.OPERATOR, RoleCode.OWNER)
  list(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.list(id);
  }
  @Get(':draftId')
  @Roles(RoleCode.ADMIN, RoleCode.OPERATOR, RoleCode.OWNER)
  get(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('draftId', new ParseUUIDPipe()) draftId: string,
  ) {
    return this.service.get(id, draftId);
  }
  @Patch(':draftId')
  edit(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('draftId', new ParseUUIDPipe()) draftId: string,
    @Body() dto: EditDraftDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.review(id, draftId, actor, dto, 'edit');
  }
  @Post(':draftId/approve')
  @HttpCode(202)
  approve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('draftId', new ParseUUIDPipe()) draftId: string,
    @Body() dto: ReviewDraftDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.review(id, draftId, actor, dto, 'approve');
  }
  @Post(':draftId/reject')
  @HttpCode(200)
  reject(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('draftId', new ParseUUIDPipe()) draftId: string,
    @Body() dto: ReviewDraftDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.review(id, draftId, actor, dto, 'reject');
  }
}
