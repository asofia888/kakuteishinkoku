import { describe, expect, it } from 'vitest';
import {
  escapeFormulaCell,
  parseAmountCell,
  parseCsv,
  parseDateCell,
  resolveTypeAndAmount,
  transactionsToCsv,
} from './csv';
import { Transaction } from './types';

describe('parseDateCell', () => {
  it('西暦の各種区切りを読める', () => {
    expect(parseDateCell('2026/1/5')).toBe('2026-01-05');
    expect(parseDateCell('2026-01-05')).toBe('2026-01-05');
    expect(parseDateCell('2026年1月5日')).toBe('2026-01-05');
    expect(parseDateCell('2026.1.5')).toBe('2026-01-05');
  });

  it('区切りなし8桁(楽天銀行形式)を読める', () => {
    expect(parseDateCell('20260105')).toBe('2026-01-05');
    expect(parseDateCell('20261231')).toBe('2026-12-31');
  });

  it('和暦(令和・平成)を読める', () => {
    expect(parseDateCell('令和7年1月5日')).toBe('2025-01-05');
    expect(parseDateCell('R7.1.5')).toBe('2025-01-05');
    expect(parseDateCell('令和元年5月1日')).toBe('2019-05-01');
    expect(parseDateCell('H31.4.30')).toBe('2019-04-30');
  });

  it('存在しない日付・日付でない文字列は弾く', () => {
    expect(parseDateCell('2026/2/30')).toBeNull();
    expect(parseDateCell('20261340')).toBeNull(); // 13月40日
    expect(parseDateCell('12345678')).toBeNull(); // 口座番号のような8桁
    expect(parseDateCell('メモ')).toBeNull();
    expect(parseDateCell('')).toBeNull();
  });
});

describe('parseAmountCell', () => {
  it('カンマ・円記号・全角数字を処理できる', () => {
    expect(parseAmountCell('1,000')).toBe(1000);
    expect(parseAmountCell('¥12,345')).toBe(12345);
    expect(parseAmountCell('１,０００円')).toBe(1000);
  });

  it('各種マイナス表記を負数にする', () => {
    expect(parseAmountCell('▲1,000')).toBe(-1000);
    expect(parseAmountCell('△500')).toBe(-500);
    expect(parseAmountCell('-2,000')).toBe(-2000);
    expect(parseAmountCell('−300')).toBe(-300); // 全角マイナス
    expect(parseAmountCell('1,000-')).toBe(-1000); // 後置マイナス
  });

  it('金額でないセルは null', () => {
    expect(parseAmountCell('')).toBeNull();
    expect(parseAmountCell('1回払い')).toBeNull();
    expect(parseAmountCell('0')).toBeNull();
  });
});

describe('parseCsv: 銀行ヘッダーの認識', () => {
  it('三菱UFJ系(支払い金額/預かり金額)で出金・入金の両方を取り込める', () => {
    const csv = [
      '"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高","メモ"',
      '"2026/1/6","カ−ド","ラクテンカ−ドサ−ビス","52,340","","1,000,000",""',
      '"2026/1/25","振込","カ)エ−ビ−シ−","","310,000","1,310,000",""',
    ].join('\r\n');
    const { rows, skipped, guessed } = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ date: '2026-01-06', description: 'カ−ド', amount: -52340 });
    expect(rows[1].amount).toBe(310000); // 入金行が捨てられないこと
    expect(skipped).toBe(0);
    expect(guessed).toBe(false); // 列名で認識できている
  });

  it('三井住友系(お引出し/お預入れ)で出金行が捨てられない', () => {
    const csv = [
      '年月日,お引出し,お預入れ,お取り扱い内容,残高,メモ',
      '2026/1/13,880,,コンビニATM,99120,',
      '2026/1/29,,200000,フリコミ カ)デフ,299120,',
    ].join('\n');
    const { rows } = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].amount).toBe(-880);
    expect(rows[1].amount).toBe(200000);
    expect(rows[0].description).toBe('コンビニATM');
  });

  it('楽天銀行系(YYYYMMDD日付 + 入出金の±1列)で符号を保って取り込める', () => {
    const csv = [
      '取引日,入出金(円),取引後残高(円),入出金内容',
      '20260115,-1200,98800,コンビニATM引き出し',
      '20260125,310000,408800,ホウシユウ カ)エービーシー',
    ].join('\n');
    const { rows } = parseCsv(csv);
    expect(rows).toHaveLength(2);
    // 「入出金」列が出金列と誤認されて全行マイナスにならないこと
    expect(rows[0]).toEqual({ date: '2026-01-15', description: 'コンビニATM引き出し', amount: -1200 });
    expect(rows[1].amount).toBe(310000);
  });

  it('PayPay銀行系(操作日/支払金額/受取金額)を取り込める', () => {
    const csv = [
      '操作日,摘要,支払金額,受取金額,残高',
      '2026/2/2,デビット決済,3300,,96700',
      '2026/2/20,給与振込,,150000,246700',
    ].join('\n');
    const { rows } = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].amount).toBe(-3300);
    expect(rows[1].amount).toBe(150000);
  });

  it('イオン銀行系(入払区分 + 金額列)で区分から符号を決める', () => {
    const csv = [
      '取引日,入払区分,金額,残高,摘要',
      '2026/2/10,出金,1200,98800,コンビニATM',
      '2026/2/25,入金,310000,408800,フリコミ ホウシュウ',
    ].join('\n');
    const { rows } = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].amount).toBe(-1200);
    expect(rows[1].amount).toBe(310000);
  });

  it('クレジットカード系(利用日/利用金額)で▲の返金行も読める', () => {
    const csv = [
      '利用日,利用店名・商品名,利用者,支払方法,利用金額,支払手数料,支払総額',
      '2026/2/1,AMAZON.CO.JP,本人,1回払い,3980,0,3980',
      '2026/2/3,AMAZON.CO.JP ヘンピン,本人,1回払い,"▲1,000",0,"▲1,000"',
    ].join('\n');
    const { rows } = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ date: '2026-02-01', description: 'AMAZON.CO.JP', amount: 3980 });
    expect(rows[1].amount).toBe(-1000);
  });
});

describe('parseCsv: 前置き行・集計行・ヘッダーなし', () => {
  it('口座情報などの前置き行があってもヘッダー行を見つけて取り込める', () => {
    const csv = [
      '○○銀行 入出金明細',
      '口座番号:1234567',
      '日付,摘要,出金金額,入金金額,残高',
      '2026/3/1,ATM,10000,,90000',
      '2026/3/5,フリコミ,,50000,140000',
    ].join('\n');
    const { rows, skipped } = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].amount).toBe(-10000);
    expect(skipped).toBe(2); // 前置き2行を読み飛ばしたことがユーザーに伝わる
  });

  it('集計行(合計など)は読み飛ばして件数を報告する', () => {
    const csv = [
      '日付,摘要,出金金額,入金金額,残高',
      '2026/3/1,ATM,10000,,90000',
      '合計,,10000,0,',
    ].join('\n');
    const { rows, skipped } = parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('ヘッダーなしCSVはヒューリスティックで読め、推測フラグが立つ', () => {
    const csv = ['2026/3/1,ヨドバシカメラ,-12800', '2026/3/5,カ)クライアント,50000'].join('\n');
    const { rows, skipped, guessed } = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ date: '2026-03-01', description: 'ヨドバシカメラ', amount: -12800 });
    expect(skipped).toBe(0);
    expect(guessed).toBe(true); // 取込画面で種別の確認を促すためのフラグ
  });

  it('空のCSVは0件・スキップ0', () => {
    expect(parseCsv('')).toEqual({ rows: [], skipped: 0, guessed: false });
  });
});

describe('CSVエクスポートのインジェクション対策', () => {
  it("= + - @ 等で始まるセルは ' を前置して数式化を防ぐ", () => {
    expect(escapeFormulaCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(escapeFormulaCell('@遠隔参照')).toBe("'@遠隔参照");
    expect(escapeFormulaCell('+1234')).toBe("'+1234");
    expect(escapeFormulaCell('-キャンセル分')).toBe("'-キャンセル分");
    expect(escapeFormulaCell('AMAZON.CO.JP')).toBe('AMAZON.CO.JP'); // 通常の摘要はそのまま
  });

  it('transactionsToCsv は摘要の数式を無害化し、引用符もエスケープする', () => {
    const tx: Transaction = {
      id: 't1',
      date: '2026-05-01',
      amount: 1000,
      description: '=HYPERLINK("http://evil.example","請求書")',
      type: 'expense',
      account: 'supplies',
      approved: true,
      anbunApplied: false,
      businessAmount: 1000,
      source: 'csv',
      createdAt: 1,
      fund: 'bank',
    };
    const csv = transactionsToCsv([tx]);
    // 先頭に ' が付き、内部の " は "" にエスケープされる
    expect(csv).toContain('"\'=HYPERLINK(""http://evil.example"",""請求書"")"');
  });
});

describe('resolveTypeAndAmount', () => {
  const row = { date: '2026-01-05', description: 'テスト', amount: -1200 };
  it('自動判定: 符号で収支を決める', () => {
    expect(resolveTypeAndAmount(row, 'auto')).toEqual({ type: 'expense', amount: 1200 });
    expect(resolveTypeAndAmount({ ...row, amount: 500 }, 'auto')).toEqual({
      type: 'income',
      amount: 500,
    });
  });
  it('すべて支出/収入: 符号に関わらず種別を固定し絶対値にする', () => {
    expect(resolveTypeAndAmount(row, 'expense')).toEqual({ type: 'expense', amount: 1200 });
    expect(resolveTypeAndAmount(row, 'income')).toEqual({ type: 'income', amount: 1200 });
  });
});
