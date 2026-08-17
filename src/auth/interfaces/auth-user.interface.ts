import { RoleCode } from '../../../generated/prisma/enums';

export interface AuthUser {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    passwordHash: string;
    isActive: boolean;
    lastLoginAt: Date | null;

    roles: {
        role: {
            code: RoleCode;
            name: string;
        };
    }[];
}