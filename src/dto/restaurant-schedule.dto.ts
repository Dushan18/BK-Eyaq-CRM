import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

import { DayOfWeek } from '../../generated/prisma/enums';

export const RESTAURANT_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

type ScheduleTimeFields = {
  isOpen: boolean;
  openTime?: string | null;
  closeTime?: string | null;
};

export function isScheduleTimeCoherent(schedule: ScheduleTimeFields): boolean {
  if (schedule.isOpen === false) {
    return schedule.openTime == null && schedule.closeTime == null;
  }

  if (schedule.isOpen !== true) {
    return false;
  }

  if (
    typeof schedule.openTime !== 'string' ||
    typeof schedule.closeTime !== 'string' ||
    !RESTAURANT_TIME_PATTERN.test(schedule.openTime) ||
    !RESTAURANT_TIME_PATTERN.test(schedule.closeTime)
  ) {
    return false;
  }

  return schedule.openTime < schedule.closeTime;
}

@ValidatorConstraint({ name: 'restaurantScheduleTimes', async: false })
class RestaurantScheduleTimesConstraint implements ValidatorConstraintInterface {
  validate(_value: boolean, arguments_: ValidationArguments): boolean {
    return isScheduleTimeCoherent(arguments_.object as ScheduleTimeFields);
  }

  defaultMessage(): string {
    return 'Un día abierto requiere openTime y closeTime en formato HH:mm, con apertura anterior al cierre; un día cerrado no admite horas';
  }
}

export class RestaurantScheduleDto {
  @IsEnum(DayOfWeek)
  dayOfWeek!: DayOfWeek;

  @IsBoolean()
  @Validate(RestaurantScheduleTimesConstraint)
  isOpen!: boolean;

  @IsOptional()
  @IsString()
  @Matches(RESTAURANT_TIME_PATTERN, {
    message: 'openTime debe tener el formato HH:mm',
  })
  openTime?: string | null;

  @IsOptional()
  @IsString()
  @Matches(RESTAURANT_TIME_PATTERN, {
    message: 'closeTime debe tener el formato HH:mm',
  })
  closeTime?: string | null;
}
