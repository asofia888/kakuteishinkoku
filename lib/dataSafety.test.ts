import { describe, expect, it } from 'vitest';
import { daysSince, shouldRemindBackup } from './dataSafety';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 8, 25);

describe('shouldRemindBackup: バックアップの催促', () => {
  it('取引がなければ催促しない', () => {
    expect(shouldRemindBackup({ now, hasData: false, lastBackupAt: null, snoozeUntil: null })).toBe(false);
  });
  it('一度もバックアップしていなければ催促する', () => {
    expect(shouldRemindBackup({ now, hasData: true, lastBackupAt: null, snoozeUntil: null })).toBe(true);
  });
  it('最後のバックアップから30日で催促し、29日なら催促しない', () => {
    expect(shouldRemindBackup({ now, hasData: true, lastBackupAt: now - 29 * DAY, snoozeUntil: null })).toBe(false);
    expect(shouldRemindBackup({ now, hasData: true, lastBackupAt: now - 30 * DAY, snoozeUntil: null })).toBe(true);
  });
  it('「あとで」を押したらスヌーズ期間中は催促しない', () => {
    expect(shouldRemindBackup({ now, hasData: true, lastBackupAt: null, snoozeUntil: now + DAY })).toBe(false);
    expect(shouldRemindBackup({ now, hasData: true, lastBackupAt: null, snoozeUntil: now - 1 })).toBe(true);
  });
  it('経過日数', () => {
    expect(daysSince(now, now - 3.5 * DAY)).toBe(3);
    expect(daysSince(now, null)).toBeNull();
  });
});
