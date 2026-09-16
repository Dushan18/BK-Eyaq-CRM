import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, RoleCode } from '../generated/prisma/client';
import * as bcrypt from 'bcrypt';
import { seedCommercialCatalog } from './seed-commercial-catalog';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
    throw new Error('La variable de entorno DATABASE_URL es obligatoria');
}

const adapter = new PrismaPg({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter });

async function main(): Promise<void> {
    const roles = [
        {
            code: RoleCode.ADMIN,
            name: 'Administrador',
            description: 'Acceso completo al CRM',
        },
        {
            code: RoleCode.OWNER,
            name: 'Propietario',
            description: 'Responsable de validación y configuración',
        },
        {
            code: RoleCode.OPERATOR,
            name: 'Operador',
            description: 'Gestiona calendario, clientes y reservas',
        },
        {
            code: RoleCode.SUPPORT,
            name: 'Soporte EYAQ',
            description: 'Acceso técnico, soporte y revisión de errores',
        },
    ];

    for (const role of roles) {
        await prisma.role.upsert({
            where: {
                code: role.code,
            },
            update: {
                name: role.name,
                description: role.description,
            },
            create: role,
        });
    }

    const adminRole = await prisma.role.findUniqueOrThrow({
        where: {
            code: RoleCode.ADMIN,
        },
    });

    const adminEmail =
        process.env.ADMIN_EMAIL?.trim().toLowerCase() ??
        'admin@eyaqsystems.com';

    const adminPassword = process.env.ADMIN_PASSWORD ?? 'ChangeMe123!';

    const passwordHash = await bcrypt.hash(adminPassword, 12);

    const admin = await prisma.user.upsert({
        where: {
            email: adminEmail,
        },
        update: {
            firstName: 'Administrador',
            lastName: 'EYAQ',
            isActive: true,
        },
        create: {
            firstName: 'Administrador',
            lastName: 'EYAQ',
            email: adminEmail,
            passwordHash,
            isActive: true,
        },
    });

    await prisma.userRole.upsert({
        where: {
            userId_roleId: {
                userId: admin.id,
                roleId: adminRole.id,
            },
        },
        update: {},
        create: {
            userId: admin.id,
            roleId: adminRole.id,
        },
    });

    await seedCommercialCatalog(prisma);

    console.log('Seed ejecutado correctamente');
    console.log(`Administrador: ${admin.email}`);
    console.log('Catálogo comercial: 16 categorías y 86 elementos');
}

main()
    .catch((error: unknown) => {
        console.error('Error al ejecutar el seed:', error);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
