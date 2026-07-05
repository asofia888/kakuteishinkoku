import { describe, expect, it } from 'vitest';
import {
  bookValueAtEnd,
  bookValueAtStart,
  depreciationForYear,
  depreciationSchedule,
  disposalResidual,
  straightLineRate,
  yearDepreciationTotals,
} from './assets';
import { FixedAsset } from './types';

let seq = 0;
function asset(over: Partial<FixedAsset>): FixedAsset {
  seq++;
  return {
    id: `a${seq}`,
    name: 'テスト資産',
    acquiredDate: '2025-07-10',
    cost: 240000,
    method: 'straight',
    usefulLife: 4,
    businessRatio: 100,
    createdAt: seq,
    ...over,
  };
}

describe('straightLineRate: 定額法の償却率', () => {
  it('国税庁の償却率表と一致する(1/n を小数第3位で切り上げ)', () => {
    expect(straightLineRate(2)).toBe(0.5);
    expect(straightLineRate(3)).toBe(0.334);
    expect(straightLineRate(4)).toBe(0.25);
    expect(straightLineRate(5)).toBe(0.2);
    expect(straightLineRate(6)).toBe(0.167);
    expect(straightLineRate(7)).toBe(0.143);
    expect(straightLineRate(10)).toBe(0.1);
    expect(straightLineRate(15)).toBe(0.067);
    expect(straightLineRate(17)).toBe(0.059);
  });
});

describe('depreciationSchedule: 定額法', () => {
  it('取得年は月割り、以後は年額、最後は備忘価額1円まで償却する', () => {
    // 240,000円・4年(率0.250)・2025年7月取得 → 初年6ヶ月
    const rows = depreciationSchedule(asset({}));
    expect(rows).toEqual([
      { year: 2025, months: 6, opening: 240000, dep: 30000, closing: 210000 },
      { year: 2026, months: 12, opening: 210000, dep: 60000, closing: 150000 },
      { year: 2027, months: 12, opening: 150000, dep: 60000, closing: 90000 },
      { year: 2028, months: 12, opening: 90000, dep: 60000, closing: 30000 },
      { year: 2029, months: 12, opening: 30000, dep: 29999, closing: 1 }, // 備忘価額1円
    ]);
  });

  it('1月取得は初年から12ヶ月償却する', () => {
    const rows = depreciationSchedule(asset({ acquiredDate: '2025-01-15', cost: 100000, usefulLife: 5 }));
    expect(rows[0]).toEqual({ year: 2025, months: 12, opening: 100000, dep: 20000, closing: 80000 });
  });

  it('除却した年は除却月まで月割りし、それ以降は償却しない', () => {
    const rows = depreciationSchedule(asset({ disposedDate: '2026-03-31' }));
    // 2026年は1〜3月の3ヶ月分のみ
    expect(rows).toEqual([
      { year: 2025, months: 6, opening: 240000, dep: 30000, closing: 210000 },
      { year: 2026, months: 3, opening: 210000, dep: 15000, closing: 195000 },
    ]);
  });

  it('償却費は整数演算で計算する(浮動小数点の1円ズレの回帰)', () => {
    // 7年(率0.143)・12月取得(1ヶ月)・12,000円: float計算だと 142円 になってしまう
    // 正: floor(12,000 × 143 × 1 / 12,000) = 143円
    const rows = depreciationSchedule(
      asset({ cost: 12_000, usefulLife: 7, acquiredDate: '2026-12-05' }),
    );
    expect(rows[0]).toMatchObject({ year: 2026, months: 1, dep: 143 });
    // 84,000円でも同様(float: 1,000円 / 正: 1,001円)
    const rows2 = depreciationSchedule(
      asset({ cost: 84_000, usefulLife: 7, acquiredDate: '2026-12-05' }),
    );
    expect(rows2[0].dep).toBe(1_001);
  });
});

describe('disposalResidual: 除却時の残存簿価(事業主貸への振替額)', () => {
  it('除却年に「取得価額 − 償却累計」を返し、他の年は0', () => {
    const a = asset({ disposedDate: '2026-03-31' }); // 2026年3ヶ月償却後の残存 195,000
    expect(disposalResidual(a, 2026)).toBe(195000);
    expect(disposalResidual(a, 2025)).toBe(0);
    expect(disposalResidual(a, 2027)).toBe(0); // 振替済み
  });

  it('償却終了後(備忘価額1円)の除却は1円を振り替える', () => {
    const a = asset({ disposedDate: '2031-06-15' }); // 2029年に1円まで償却済み
    expect(disposalResidual(a, 2031)).toBe(1);
  });

  it('一括償却(3年均等を続ける)・少額特例(残高0)は対象外', () => {
    const lump = asset({ method: 'lump3', cost: 150000, acquiredDate: '2025-05-01', disposedDate: '2026-02-01' });
    expect(disposalResidual(lump, 2026)).toBe(0);
    // 一括償却は除却後も償却が続く
    expect(depreciationForYear(lump, 2027).total).toBe(50000);
    const imm = asset({ method: 'immediate', cost: 280000, acquiredDate: '2025-05-01', disposedDate: '2026-02-01' });
    expect(disposalResidual(imm, 2026)).toBe(0);
  });
});

describe('depreciationSchedule: 一括償却・少額特例', () => {
  it('一括償却は3年均等(月割りなし)で端数は最終年に寄せる', () => {
    const rows = depreciationSchedule(
      asset({ method: 'lump3', cost: 150000, acquiredDate: '2026-11-20' }),
    );
    expect(rows).toEqual([
      { year: 2026, months: 12, opening: 150000, dep: 50000, closing: 100000 },
      { year: 2027, months: 12, opening: 100000, dep: 50000, closing: 50000 },
      { year: 2028, months: 12, opening: 50000, dep: 50000, closing: 0 },
    ]);
    // 3で割り切れない場合
    const rows2 = depreciationSchedule(asset({ method: 'lump3', cost: 100000, acquiredDate: '2026-01-01' }));
    expect(rows2.map((r) => r.dep)).toEqual([33333, 33333, 33334]);
  });

  it('少額特例は取得年に全額を経費算入する', () => {
    const rows = depreciationSchedule(
      asset({ method: 'immediate', cost: 280000, acquiredDate: '2026-09-01' }),
    );
    expect(rows).toEqual([{ year: 2026, months: 4, opening: 280000, dep: 280000, closing: 0 }]);
  });
});

describe('depreciationForYear: 事業専用割合', () => {
  it('経費算入額 = 償却費 × 事業割合(切り捨て)、残りは事業主貸', () => {
    const a = asset({ businessRatio: 70 });
    const d = depreciationForYear(a, 2026); // 償却費 60,000
    expect(d.total).toBe(60000);
    expect(d.business).toBe(42000);
    expect(d.ownerPart).toBe(18000);
    expect(d.months).toBe(12);
  });

  it('償却のない年は0', () => {
    expect(depreciationForYear(asset({}), 2024).total).toBe(0);
    expect(depreciationForYear(asset({}), 2031).total).toBe(0);
  });
});

describe('帳簿価額(貸借対照表用)', () => {
  const a = asset({}); // 2025-07取得 240,000
  it('期首・期末の未償却残高を返す(取得前は0)', () => {
    expect(bookValueAtStart(a, 2025)).toBe(0); // 取得年の1/1は未保有
    expect(bookValueAtEnd(a, 2025)).toBe(210000);
    expect(bookValueAtStart(a, 2026)).toBe(210000);
    expect(bookValueAtEnd(a, 2026)).toBe(150000);
    expect(bookValueAtEnd(a, 2029)).toBe(1); // 償却終了後は備忘価額
    expect(bookValueAtEnd(a, 2035)).toBe(1);
  });

  it('除却した資産は除却年の期末からB/Sに残らない(残存簿価は事業主貸へ)', () => {
    const d = asset({ disposedDate: '2026-03-31' });
    expect(bookValueAtEnd(d, 2025)).toBe(210000); // 除却前は従来どおり
    expect(bookValueAtStart(d, 2026)).toBe(210000);
    expect(bookValueAtEnd(d, 2026)).toBe(0); // 除却年の年末は帳簿から外れる
    expect(bookValueAtStart(d, 2027)).toBe(0);
    expect(bookValueAtEnd(d, 2030)).toBe(0);
    // 一括償却は除却後も未償却残高が残る(3年均等を続ける)
    const lump = asset({ method: 'lump3', cost: 150000, acquiredDate: '2025-05-01', disposedDate: '2026-02-01' });
    expect(bookValueAtEnd(lump, 2026)).toBe(50000);
  });
});

describe('yearDepreciationTotals: 複数資産の合計', () => {
  it('全資産の償却費と経費算入額を合計する', () => {
    const assets = [
      asset({}), // 2026: 60,000(100%)
      asset({ method: 'lump3', cost: 150000, acquiredDate: '2026-03-10' }), // 2026: 50,000
      asset({ businessRatio: 50 }), // 2026: 60,000 × 50% = 30,000
    ];
    const t = yearDepreciationTotals(assets, 2026);
    expect(t.total).toBe(170000);
    expect(t.business).toBe(140000);
  });
});

describe('繰延資産(開業費)の任意償却', () => {
  const kaigyo = asset({
    method: 'deferred',
    cost: 300000,
    acquiredDate: '2025-04-01',
    deferredDep: [
      { year: 2026, amount: 200000 },
      { year: 2025, amount: 50000 },
    ],
  });

  it('指定した年・金額で償却し、残額を限度にする', () => {
    const rows = depreciationSchedule(kaigyo);
    expect(rows).toEqual([
      { year: 2025, months: 12, opening: 300000, dep: 50000, closing: 250000 },
      { year: 2026, months: 12, opening: 250000, dep: 200000, closing: 50000 },
    ]);
    expect(depreciationForYear(kaigyo, 2026).total).toBe(200000);
    expect(depreciationForYear(kaigyo, 2027).total).toBe(0); // 未設定の年は償却しない
    expect(bookValueAtEnd(kaigyo, 2026)).toBe(50000);
  });

  it('残額を超える指定は残額まで切り詰める', () => {
    const over = asset({
      method: 'deferred',
      cost: 100000,
      acquiredDate: '2025-04-01',
      deferredDep: [
        { year: 2025, amount: 80000 },
        { year: 2026, amount: 50000 }, // 残り20,000しかない
      ],
    });
    const rows = depreciationSchedule(over);
    expect(rows[1].dep).toBe(20000);
    expect(rows[1].closing).toBe(0);
  });
});
