import { describe, expect, it } from 'vitest';
import { entryForTransaction } from './ledger';
import { buildPayrollTransactions, payrollLedgerCsv, salaryWithholding } from './payroll';
import { PayrollEntry, Transaction } from './types';

describe('salaryWithholding: 源泉徴収の簡易判定(社会保険料等控除後・支払年分の税額表)', () => {
  it('2025年分まで: 甲欄は月88,000円未満0円、以上は税額表参照(null)', () => {
    expect(salaryWithholding(87_999, 'kou', 2025)).toBe(0);
    expect(salaryWithholding(88_000, 'kou', 2025)).toBeNull(); // ちょうど88,000円は課税
  });

  it('2026年分から: 甲欄の0円ラインは105,000円未満に引き上げ(令和8年分税額表)', () => {
    expect(salaryWithholding(104_999, 'kou', 2026)).toBe(0);
    expect(salaryWithholding(105_000, 'kou', 2026)).toBeNull();
    expect(salaryWithholding(90_000, 'kou', 2026)).toBe(0); // 2025年ならnullだった帯
  });

  it('乙欄: ライン未満は3.063%(切り捨て)、以上はnull(年分でラインが変わる)', () => {
    expect(salaryWithholding(80_000, 'otsu', 2025)).toBe(Math.floor(80_000 * 0.03063)); // 2,450
    expect(salaryWithholding(88_000, 'otsu', 2025)).toBeNull();
    expect(salaryWithholding(100_000, 'otsu', 2026)).toBe(Math.floor(100_000 * 0.03063)); // 3,063
    expect(salaryWithholding(105_000, 'otsu', 2026)).toBeNull();
  });

  it('丙欄: 日額ライン未満は0円、以上はnull(2025年: 9,300円 / 2026年: 9,800円)', () => {
    expect(salaryWithholding(9_299, 'hei', 2025)).toBe(0);
    expect(salaryWithholding(9_300, 'hei', 2025)).toBeNull();
    expect(salaryWithholding(9_799, 'hei', 2026)).toBe(0);
    expect(salaryWithholding(9_800, 'hei', 2026)).toBeNull();
    expect(salaryWithholding(12_000, 'hei', 2026)).toBeNull();
  });
});

describe('buildPayrollTransactions: 給与の仕訳', () => {
  it('手取りの支払いと源泉の預りに分かれ、合計が総支給額になる', () => {
    const drafts = buildPayrollTransactions({
      employee: '佐藤',
      date: '2026-07-25',
      gross: 90_000,
      withholding: 2_450,
    });
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({
      account: 'salaries',
      fund: 'bank',
      amount: 87_550,
      type: 'expense',
    });
    expect(drafts[1]).toMatchObject({ account: 'salaries', fund: 'deposit', amount: 2_450 });
    expect(drafts[0].amount + drafts[1].amount).toBe(90_000);
  });

  it('源泉0円なら手取り1件だけ', () => {
    const drafts = buildPayrollTransactions({
      employee: '田中',
      date: '2026-07-25',
      gross: 80_000,
      withholding: 0,
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].amount).toBe(80_000);
  });

  it('社会保険料等の天引きは預り金として起票され、手取り+預り2件=総支給額になる', () => {
    const drafts = buildPayrollTransactions({
      employee: '佐藤',
      date: '2026-07-25',
      gross: 120_000,
      withholding: 1_500,
      socialInsurance: 720, // 雇用保険料など
    });
    expect(drafts).toHaveLength(3);
    expect(drafts[0]).toMatchObject({ fund: 'bank', amount: 120_000 - 1_500 - 720 });
    expect(drafts[1]).toMatchObject({ fund: 'deposit', amount: 720 });
    expect(drafts[1].description).toContain('社会保険料等(預り)');
    expect(drafts[2]).toMatchObject({ fund: 'deposit', amount: 1_500 });
    expect(drafts[2].description).toContain('源泉所得税(預り)');
    expect(drafts.reduce((s, d) => s + d.amount, 0)).toBe(120_000);
  });

  it('源泉の預りは (借)給料賃金 / (貸)預り金、納付は (借)預り金 / (貸)普通預金 になる', () => {
    const tx = (over: Partial<Transaction>): Transaction => ({
      id: 't1',
      date: '2026-07-25',
      amount: 2_450,
      description: '給与 佐藤 源泉所得税(預り)',
      type: 'expense',
      account: 'salaries',
      approved: true,
      anbunApplied: false,
      businessAmount: 2_450,
      source: 'manual',
      createdAt: 1,
      fund: 'deposit',
      ...over,
    });
    const accrual = entryForTransaction(tx({}))!;
    expect(accrual.debits).toEqual([{ account: 'salaries', amount: 2_450 }]);
    expect(accrual.credits).toEqual([{ account: 'deposit', amount: 2_450 }]);

    const payment = entryForTransaction(tx({ account: 'deposit_payment', fund: 'bank' }))!;
    expect(payment.debits).toEqual([{ account: 'deposit', amount: 2_450 }]);
    expect(payment.credits).toEqual([{ account: 'bank', amount: 2_450 }]);
  });
});

describe('payrollLedgerCsv: 賃金台帳', () => {
  it('従業員別に支払日順で並び、社会保険料等の列と年間合計が付く', () => {
    const rows: PayrollEntry[] = [
      { id: '1', employee: '佐藤', date: '2026-02-25', gross: 80000, withholding: 0, socialInsurance: 480, table: 'kou', createdAt: 1 },
      { id: '2', employee: '佐藤', date: '2026-01-25', gross: 80000, withholding: 0, table: 'kou', createdAt: 2 },
      { id: '3', employee: '鈴木', date: '2026-03-10', gross: 9000, withholding: 0, table: 'hei', createdAt: 3 },
      { id: '4', employee: '佐藤', date: '2025-12-25', gross: 80000, withholding: 0, table: 'kou', createdAt: 4 }, // 他年
    ];
    const csv = payrollLedgerCsv(rows, 2026);
    expect(csv).toContain('従業員,"佐藤"');
    expect(csv).toContain('従業員,"鈴木"');
    expect(csv).toContain('支払日,税額区分,総支給額,社会保険料等,源泉徴収税額,差引支給額,備考');
    expect(csv).toContain('2026-02-25,甲欄(扶養控除等申告書あり),80000,480,0,79520,');
    expect(csv).toContain('年間合計,,160000,480,0,159520,');
    expect(csv.indexOf('2026-01-25')).toBeLessThan(csv.indexOf('2026-02-25'));
    expect(csv).not.toContain('2025-12-25');
  });
});
