import type { Level, ScheduleRule } from './resource-policy.js';

const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
/** Contribution level in force at `date` (local time). The first matching rule wins. */
export function levelAt(rules: readonly ScheduleRule[], fallback: Level, date: Date): Level {
  const now = date.getHours() * 60 + date.getMinutes(); const day = date.getDay(); const yesterday = (day + 6) % 7;
  for (const rule of rules) {
    const from = minutes(rule.from); const to = minutes(rule.to);
    if (from < to) { if (rule.days.includes(day) && now >= from && now < to) return rule.level; }
    else if (from > to) {
      // Wraps midnight: the evening part belongs to the rule's day, the morning part to the next day.
      if ((rule.days.includes(day) && now >= from) || (rule.days.includes(yesterday) && now < to)) return rule.level;
    } else if (rule.days.includes(day)) return rule.level; // from == to: the whole day
  }
  return fallback;
}
/**
 * Milliseconds until the schedule next sets contribution OFF (0 if it is OFF now), or undefined when
 * that does not happen within `horizonMs`. Scans minute by minute, so callers should cache the answer.
 */
export function nextOffMs(rules: readonly ScheduleRule[], fallback: Level, date: Date, horizonMs = 7 * 86400000): number | undefined {
  if (fallback !== 'OFF' && !rules.some(rule => rule.level === 'OFF')) return undefined;
  if (levelAt(rules, fallback, date) === 'OFF') return 0;
  const minute = 60000; const start = Math.floor(date.getTime() / minute) * minute;
  for (let at = start + minute; at - date.getTime() <= horizonMs; at += minute) if (levelAt(rules, fallback, new Date(at)) === 'OFF') return at - date.getTime();
  return undefined;
}
