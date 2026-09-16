import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';

import type { Prisma } from '../../generated/prisma/client';
import { RoleCode } from '../../generated/prisma/enums';
import { PASSWORD_SALT_ROUNDS } from '../common/constants/security.constants';
import { PrismaService } from '../database/prisma.service';
import { CreateUserDto } from '../dto/create-user.dto';
import { UpdateUserDto } from '../dto/update-user.dto';
import { UpdateUserRolesDto } from '../dto/update-user-roles.dto';
import { UpdateUserStatusDto } from '../dto/update-user-status.dto';

const publicUserSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  roles: {
    select: {
      role: {
        select: {
          code: true,
        },
      },
    },
  },
} satisfies Prisma.UserSelect;

type PublicUser = Prisma.UserGetPayload<{
  select: typeof publicUserSelect;
}>;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: {
        email: this.normalizeEmail(email),
      },
      select: {
        ...publicUserSelect,
        passwordHash: true,
      },
    });
  }

  async findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: publicUserSelect,
    });
  }

  async create(dto: CreateUserDto) {
    const email = this.normalizeEmail(dto.email);

    await this.ensureEmailAvailable(email);

    const roleRecords = await this.getRoleRecords(dto.roles);
    const passwordHash = await bcrypt.hash(dto.password, PASSWORD_SALT_ROUNDS);

    try {
      const user = await this.prisma.user.create({
        data: {
          firstName: this.normalizeName(dto.firstName, 'firstName'),
          lastName: this.normalizeName(dto.lastName, 'lastName'),
          email,
          passwordHash,
          roles: {
            create: roleRecords.map((role) => ({
              role: {
                connect: {
                  id: role.id,
                },
              },
            })),
          },
        },
        select: publicUserSelect,
      });

      return this.serializeUser(user);
    } catch (error: unknown) {
      this.throwForUniqueEmail(error);
      throw error;
    }
  }

  async findAll() {
    const users = await this.prisma.user.findMany({
      select: publicUserSelect,
      orderBy: {
        createdAt: 'desc',
      },
    });

    return users.map((user) => this.serializeUser(user));
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: publicUserSelect,
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    return this.serializeUser(user);
  }

  async update(id: string, dto: UpdateUserDto) {
    const existingUser = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
      },
    });

    if (!existingUser) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const data: Prisma.UserUpdateInput = {};

    if (dto.firstName !== undefined) {
      data.firstName = this.normalizeName(dto.firstName, 'firstName');
    }

    if (dto.lastName !== undefined) {
      data.lastName = this.normalizeName(dto.lastName, 'lastName');
    }

    if (dto.email !== undefined) {
      const email = this.normalizeEmail(dto.email);
      await this.ensureEmailAvailable(email, id);
      data.email = email;
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException(
        'Debes proporcionar al menos un campo para actualizar',
      );
    }

    try {
      const user = await this.prisma.user.update({
        where: { id },
        data,
        select: publicUserSelect,
      });

      return this.serializeUser(user);
    } catch (error: unknown) {
      this.throwForUniqueEmail(error);
      throw error;
    }
  }

  async updateStatus(id: string, dto: UpdateUserStatusDto) {
    try {
      const user = await this.prisma.$transaction(
        async (tx) => {
          const currentUser = await tx.user.findUnique({
            where: { id },
            select: {
              id: true,
              isActive: true,
              roles: {
                select: {
                  role: {
                    select: {
                      code: true,
                    },
                  },
                },
              },
            },
          });

          if (!currentUser) {
            throw new NotFoundException('Usuario no encontrado');
          }

          const isActiveAdmin =
            currentUser.isActive &&
            currentUser.roles.some(
              (userRole) => userRole.role.code === RoleCode.ADMIN,
            );

          if (!dto.isActive && isActiveAdmin) {
            const activeAdminCount = await tx.user.count({
              where: {
                isActive: true,
                roles: {
                  some: {
                    role: {
                      code: RoleCode.ADMIN,
                    },
                  },
                },
              },
            });

            if (activeAdminCount <= 1) {
              throw new ConflictException(
                'No se puede desactivar al último administrador activo',
              );
            }
          }

          const updatedUser = await tx.user.update({
            where: { id },
            data: {
              isActive: dto.isActive,
            },
            select: publicUserSelect,
          });

          if (!dto.isActive) {
            await tx.session.updateMany({
              where: {
                userId: id,
                revokedAt: null,
              },
              data: {
                revokedAt: new Date(),
              },
            });
          }

          return updatedUser;
        },
        {
          isolationLevel: 'Serializable',
        },
      );

      return this.serializeUser(user);
    } catch (error: unknown) {
      this.throwForTransactionConflict(error);
      throw error;
    }
  }

  async updateRoles(id: string, dto: UpdateUserRolesDto) {
    const roleRecords = await this.getRoleRecords(dto.roles);

    try {
      const user = await this.prisma.$transaction(
        async (tx) => {
          const currentUser = await tx.user.findUnique({
            where: { id },
            select: {
              id: true,
              isActive: true,
              roles: {
                select: {
                  role: {
                    select: {
                      code: true,
                    },
                  },
                },
              },
            },
          });

          if (!currentUser) {
            throw new NotFoundException('Usuario no encontrado');
          }

          const removesAdminRole =
            currentUser.isActive &&
            currentUser.roles.some(
              (userRole) => userRole.role.code === RoleCode.ADMIN,
            ) &&
            !dto.roles.includes(RoleCode.ADMIN);

          if (removesAdminRole) {
            const activeAdminCount = await tx.user.count({
              where: {
                isActive: true,
                roles: {
                  some: {
                    role: {
                      code: RoleCode.ADMIN,
                    },
                  },
                },
              },
            });

            if (activeAdminCount <= 1) {
              throw new ConflictException(
                'No se puede retirar el rol al último administrador activo',
              );
            }
          }

          await tx.userRole.deleteMany({
            where: {
              userId: id,
            },
          });

          await tx.userRole.createMany({
            data: roleRecords.map((role) => ({
              userId: id,
              roleId: role.id,
            })),
          });

          return tx.user.findUniqueOrThrow({
            where: { id },
            select: publicUserSelect,
          });
        },
        {
          isolationLevel: 'Serializable',
        },
      );

      return this.serializeUser(user);
    } catch (error: unknown) {
      this.throwForTransactionConflict(error);
      throw error;
    }
  }

  async updateLastLogin(id: string) {
    return this.prisma.user.update({
      where: { id },
      data: {
        lastLoginAt: new Date(),
      },
      select: {
        id: true,
      },
    });
  }

  private async ensureEmailAvailable(
    email: string,
    excludedUserId?: string,
  ): Promise<void> {
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
      },
    });

    if (existingUser && existingUser.id !== excludedUserId) {
      throw new ConflictException(
        'Ya existe un usuario registrado con este correo',
      );
    }
  }

  private async getRoleRecords(roles: RoleCode[]) {
    const uniqueRoles = [...new Set(roles)];

    if (uniqueRoles.length === 0) {
      throw new BadRequestException('Debes asignar al menos un rol');
    }

    const roleRecords = await this.prisma.role.findMany({
      where: {
        code: {
          in: uniqueRoles,
        },
      },
      select: {
        id: true,
        code: true,
      },
    });

    if (roleRecords.length !== uniqueRoles.length) {
      throw new BadRequestException('Uno o más roles no están disponibles');
    }

    return roleRecords;
  }

  private serializeUser(user: PublicUser) {
    const { roles, ...data } = user;

    return {
      ...data,
      roles: roles.map((userRole) => userRole.role.code),
    };
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private normalizeName(value: string, field: string): string {
    const normalizedValue = value.trim();

    if (!normalizedValue) {
      throw new BadRequestException(`${field} no puede contener solo espacios`);
    }

    return normalizedValue;
  }

  private hasPrismaCode(error: unknown, code: string): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === code
    );
  }

  private throwForUniqueEmail(error: unknown): void {
    if (this.hasPrismaCode(error, 'P2002')) {
      throw new ConflictException(
        'Ya existe un usuario registrado con este correo',
      );
    }
  }

  private throwForTransactionConflict(error: unknown): void {
    if (this.hasPrismaCode(error, 'P2034')) {
      throw new ConflictException(
        'La operación entró en conflicto con otro cambio; inténtalo nuevamente',
      );
    }
  }
}
