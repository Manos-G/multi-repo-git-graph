// PURE: the combined graph's time-range filter → the since/until sent to git.

export type TimeRangeKind = 'all' | 'today' | 'week' | 'sinceLock' | 'custom';

export interface TimeRange {
  kind: TimeRangeKind;
  /** yyyy-mm-dd, local, inclusive (custom only). */
  from?: string;
  /** yyyy-mm-dd, local, inclusive (custom only). */
  to?: string;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const seconds = (d: Date) => Math.floor(d.getTime() / 1000);

function parseDay(s: string | undefined): Date | undefined {
  const m = s ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined;
}

/**
 * `today`: since local midnight. `week`: since Monday 00:00 of this week (ISO weeks, as in
 * most of Europe). `sinceLock`: since the newest lock line (nothing to filter when there is
 * none). `custom`: from the first day's midnight to the end of the last day.
 */
export function timeRangeQuery(range: TimeRange, now: Date, lastLock: number | undefined): { since?: number; until?: number } {
  switch (range.kind) {
    case 'today':
      return { since: seconds(startOfDay(now)) };
    case 'week': {
      const d = startOfDay(now);
      const back = (d.getDay() + 6) % 7; // Monday = 0
      d.setDate(d.getDate() - back);
      return { since: seconds(d) };
    }
    case 'sinceLock':
      return lastLock === undefined ? {} : { since: lastLock };
    case 'custom': {
      const from = parseDay(range.from);
      const to = parseDay(range.to);
      if (to) to.setDate(to.getDate() + 1);
      return { since: from ? seconds(from) : undefined, until: to ? seconds(to) : undefined };
    }
    default:
      return {};
  }
}
