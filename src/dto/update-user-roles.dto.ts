import { ArrayMinSize, ArrayUnique, IsArray, IsEnum } from 'class-validator';

import { RoleCode } from '../../generated/prisma/enums';

export class UpdateUserRolesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(RoleCode, { each: true })
  roles!: RoleCode[];
}
