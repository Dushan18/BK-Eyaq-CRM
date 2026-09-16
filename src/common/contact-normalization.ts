import { BadRequestException } from '@nestjs/common';
import { isEmail } from 'class-validator';
import {
  isSupportedCountry,
  parsePhoneNumberFromString,
} from 'libphonenumber-js/max';

export function normalizeContactEmail(value: string): string {
  return value.trim().toLowerCase();
}

export interface ContactInput {
  phone?: string | null;
  phoneCountry?: string | null;
  email?: string | null;
}

export function normalizeContact(input: ContactInput) {
  const email = input.email == null ? null : normalizeContactEmail(input.email);
  if (email !== null && (!email || !isEmail(email) || email.length > 320)) {
    throw new BadRequestException('El correo no es válido');
  }
  const phone = input.phone == null ? null : input.phone.trim();
  const phoneCountry = input.phoneCountry?.trim().toUpperCase() ?? null;
  if (phoneCountry !== null && !isSupportedCountry(phoneCountry)) {
    throw new BadRequestException('phoneCountry debe ser un país ISO válido');
  }
  if (phoneCountry && !phone) {
    throw new BadRequestException('phoneCountry requiere un teléfono');
  }
  let normalizedPhone: string | null = null;
  if (phone !== null) {
    if (
      phone.length > 80 ||
      !/^\+?[\d\s().-]+$/.test(phone) ||
      phone.replace(/\D/g, '').length < 6 ||
      phone.replace(/\D/g, '').length > 15
    ) {
      throw new BadRequestException('El teléfono tiene un formato inválido');
    }
    if (phone.startsWith('+') || phoneCountry) {
      const parsed = parsePhoneNumberFromString(phone, {
        defaultCountry: phoneCountry ?? undefined,
        extract: false,
      });
      if (!parsed?.isValid()) {
        throw new BadRequestException(
          'El teléfono no es válido para el país indicado',
        );
      }
      normalizedPhone = parsed.number;
    }
  }
  if (!normalizedPhone && !email) {
    throw new BadRequestException(
      'Proporciona un email válido o un teléfono internacional; para un número nacional indica phoneCountry',
    );
  }
  return {
    phone,
    phoneCountry,
    normalizedPhone,
    email,
    normalizedEmail: email,
  };
}
