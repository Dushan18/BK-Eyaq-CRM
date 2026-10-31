import {
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class GenerateDraftDto {
  @IsUUID() sourceMessageId!: string;
}
export class ReviewDraftDto {
  @IsInt() @Min(1) @Max(2147483646) revision!: number;
}
export class EditDraftDto extends ReviewDraftDto {
  @IsString() @Matches(/\S/) @MaxLength(4096) content!: string;
}
