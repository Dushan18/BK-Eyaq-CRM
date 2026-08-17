import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';


@Injectable()
export class SessionsService {
    constructor(
        private readonly prisma: PrismaService,
    ) { }

    async create(data: {
        id: string;
        userId: string;
        refreshTokenHash: string;
        expiresAt: Date;
        userAgent?: string;
        ipAddress?: string;
    }) {
        return this.prisma.session.create({
            data: {
                id: data.id,
                userId: data.userId,
                refreshTokenHash: data.refreshTokenHash,
                expiresAt: data.expiresAt,
                userAgent: data.userAgent,
                ipAddress: data.ipAddress,
            },
        });
    }

    async findById(id: string) {
        return this.prisma.session.findUnique({
            where: {
                id,
            },
        });
    }

    async findActiveByIdAndUserId(
        id: string,
        userId: string,
    ) {
        return this.prisma.session.findFirst({
            where: {
                id,
                userId,
                revokedAt: null,
                expiresAt: {
                    gt: new Date(),
                },
            },
        });
    }

    async revoke(id: string) {
        return this.prisma.session.update({
            where: {
                id,
            },
            data: {
                revokedAt: new Date(),
            },
        });
    }

    async rotateRefreshToken(
        id: string,
        currentRefreshTokenHash: string,
        newRefreshTokenHash: string,
    ) {
        const now = new Date();

        return this.prisma.session.updateMany({
            where: {
                id,
                refreshTokenHash: currentRefreshTokenHash,
                revokedAt: null,
                expiresAt: {
                    gt: now,
                },
            },
            data: {
                refreshTokenHash: newRefreshTokenHash,
                lastUsedAt: now,
            },
        });
    }
}
