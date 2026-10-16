import { Transform, Type, type TransformFnParams } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ContactChannel } from '../../generated/prisma/enums';

const provided = (_: object, value: unknown) => value !== undefined;
const boolean = ({ value }: TransformFnParams): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

export class ConversationMessagesQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page = 1;
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}
export class ConversationQueryDto extends ConversationMessagesQueryDto {
  @ValidateIf(provided)
  @IsEnum(ContactChannel)
  channel?: ContactChannel;
  @ValidateIf(provided)
  @IsUUID()
  customerId?: string;
  @ValidateIf(provided)
  @IsUUID()
  assignedUserId?: string;
  @Transform(boolean)
  @ValidateIf(provided)
  @IsBoolean()
  unreadOnly?: boolean;
  @Transform(boolean)
  @ValidateIf(provided)
  @IsBoolean()
  isAssistantPaused?: boolean;
  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @ValidateIf(provided)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  search?: string;
}
export class AssignConversationDto {
  @ValidateIf((_: object, value: unknown) => value !== null)
  @IsUUID()
  assignedUserId!: string | null;
}
export class UpdateAssistantPauseDto {
  @IsBoolean()
  paused!: boolean;
}
export class MarkConversationReadDto {
  @IsUUID()
  throughMessageId!: string;
}
