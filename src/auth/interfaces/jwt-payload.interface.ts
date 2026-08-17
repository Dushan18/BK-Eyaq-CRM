import { RoleCode } from '../../../generated/prisma/enums';

export interface JwtPayload {
    sub: string;
    sessionId: string;
    email: string;
    roles: RoleCode[];
}