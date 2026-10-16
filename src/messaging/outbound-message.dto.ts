import { Equals, IsString, Matches, MaxLength } from 'class-validator';

export class OutboundMessageDto {
  @Equals('TEXT')
  type!: 'TEXT';

  @IsString()
  @Matches(/\S/)
  @MaxLength(4096)
  content!: string;
}
