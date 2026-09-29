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
