import { RoleCode } from '../../../generated/prisma/enums';

export interface AuthenticatedUser {
    id: string;
    sessionId: string;
    firstName: string;
    lastName: string;
    email: string;
    roles: RoleCode[];
}