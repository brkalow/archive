export type Period = "today" | "week" | "month" | "all";

export interface DateRange {
  startDate: string;
  endDate: string;
}

/**
 * Epoch date used for "all time" queries.
 * Set to a date before the application was created to ensure all data is captured.
 */
const ALL_TIME_START_DATE = "2020-01-01";

/**
 * Calculate date range for a given period
 */
export function getDateRange(period: Period): DateRange {
  const now = new Date();
  const endDate = now.toISOString().slice(0, 10);

  let startDate: string;

  switch (period) {
    case "today":
      startDate = endDate;
      break;

    case "week": {
      const weekAgo = new Date(now);
      weekAgo.setDate(weekAgo.getDate() - 7);
      startDate = weekAgo.toISOString().slice(0, 10);
      break;
    }

    case "month": {
      const monthAgo = new Date(now);
      monthAgo.setMonth(monthAgo.getMonth() - 1);
      startDate = monthAgo.toISOString().slice(0, 10);
      break;
    }

    case "all":
      startDate = ALL_TIME_START_DATE;
      break;

    default:
      startDate = endDate;
  }

  return { startDate, endDate };
}

/**
 * Parse period from query param with validation
 */
export function parsePeriod(value: string | null): Period {
  if (value === "today" || value === "week" || value === "month" || value === "all") {
    return value;
  }
  return "week";  // Default to week if invalid
}

/**
 * Get all dates between start and end (inclusive)
 * Uses UTC to avoid timezone-related off-by-one errors
 */
export function getDatesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  // Append T00:00:00Z to ensure UTC interpretation
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  const current = new Date(start);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
}

/**
 * Fill gaps in timeseries data with zero values
 * Ensures every date in the range has a value
 */
export function fillTimeseriesGaps(
  data: Array<{ date: string; value: number }>,
  startDate: string,
  endDate: string
): Array<{ date: string; value: number }> {
  const allDates = getDatesBetween(startDate, endDate);
  const valuesByDate = new Map<string, number>();

  for (const item of data) {
    valuesByDate.set(item.date, item.value);
  }

  return allDates.map(date => ({
    date,
    value: valuesByDate.get(date) ?? 0,
  }));
}
