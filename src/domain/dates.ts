import { DateTime } from 'luxon';
import { NutritionMcpError } from '../errors.js';

export const todayInZone = (timezone: string): string => {
  const date = DateTime.now().setZone(timezone);
  const isoDate = date.toISODate();
  if (!date.isValid || isoDate === null) {
    throw new NutritionMcpError('CONFIG_ERROR', 'The configured IANA time zone is invalid.');
  }
  return isoDate;
};

export const enumerateDates = (
  startDate: string,
  endDate: string,
  timezone: string,
  maximumDays: number,
): string[] => {
  let cursor = DateTime.fromISO(startDate, { zone: timezone }).startOf('day');
  const end = DateTime.fromISO(endDate, { zone: timezone }).startOf('day');
  const days = Math.floor(end.diff(cursor, 'days').days) + 1;
  if (!cursor.isValid || !end.isValid || days < 1) {
    throw new NutritionMcpError('VALIDATION_ERROR', 'Invalid date range.');
  }
  if (days > maximumDays) {
    throw new NutritionMcpError(
      'DATE_RANGE_TOO_LARGE',
      `The date range is limited to ${maximumDays} days.`,
      { details: { requested_days: days, maximum_days: maximumDays } },
    );
  }
  const result: string[] = [];
  while (cursor <= end) {
    result.push(cursor.toISODate() ?? '');
    cursor = cursor.plus({ days: 1 });
  }
  return result;
};

export const resolveDateOrRange = (
  input: {
    date?: string | undefined;
    start_date?: string | undefined;
    end_date?: string | undefined;
  },
  timezone: string,
  maximumDays: number,
): string[] => {
  if (input.date !== undefined) return [input.date];
  if (input.start_date !== undefined && input.end_date !== undefined) {
    return enumerateDates(input.start_date, input.end_date, timezone, maximumDays);
  }
  return [todayInZone(timezone)];
};
