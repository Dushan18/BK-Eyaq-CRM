import { BadRequestException } from '@nestjs/common';

export const COMMERCIAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

type LocalizedNames = {
  nameEs?: string | null;
  nameEn?: string | null;
};

type CommercialSchedule = {
  isAvailable: boolean;
  startTime?: string | null;
  endTime?: string | null;
};

export function normalizeOptionalString(value?: string | null): string | null {
  if (value == null) {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

export function requireLocalizedName(
  names: LocalizedNames,
  resourceName: string,
): { nameEs: string | null; nameEn: string | null } {
  const nameEs = normalizeOptionalString(names.nameEs);
  const nameEn = normalizeOptionalString(names.nameEn);

  if (!nameEs && !nameEn) {
    throw new BadRequestException(
      `${resourceName} debe tener al menos un nombre en español o inglés`,
    );
  }

  return { nameEs, nameEn };
}

export function normalizeCommercialName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLocaleLowerCase('es')
    .replace(/\s+/g, ' ');
}

export function isCommercialScheduleCoherent(
  schedule: CommercialSchedule,
): boolean {
  if (schedule.isAvailable === false) {
    return schedule.startTime == null && schedule.endTime == null;
  }

  return (
    schedule.isAvailable === true &&
    typeof schedule.startTime === 'string' &&
    typeof schedule.endTime === 'string' &&
    COMMERCIAL_TIME_PATTERN.test(schedule.startTime) &&
    COMMERCIAL_TIME_PATTERN.test(schedule.endTime) &&
    schedule.startTime !== schedule.endTime
  );
}

export function serializeMoney(
  value: { toFixed(decimalPlaces: number): string } | null,
): string | null {
  return value?.toFixed(2) ?? null;
}
