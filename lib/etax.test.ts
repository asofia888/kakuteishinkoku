import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildKessanshoXtx, etaxInputProblems, jpEra, KessanshoInput } from './etax';
import { DEFAULT_ISSUER } from './types';

const issuer = {
  ...DEFAULT_ISSUER,
  name: '山田 太郎',
  nameKana: 'ヤマダ タロウ',
  address: '東京都墨田区○○ 1-2-3',
  tel: '090-0000-0000',
  yago: 'ヤマダデザイン',
  shokugyo: 'デザイン業',
  etaxId: '1234567890123456',
  zeimushoCode: '01143',
  zeimushoName: '新宿',
};

function fixture(): KessanshoInput {
  return {
    year: 2025, // 令和7年分
    issuer,
    createdDate: '2026-03-10',
    pl: {
      sales: 5_068_000,
      inventoryOpening: 0,
      purchases: 0,
      inventoryClosing: 0,
      costOfSales: 0,
      grossProfit: 5_068_000,
      expenseByAccount: {
        utilities: 55_680,
        communication: 47_364,
        supplies: 72_000,
        depreciation: 110_000,
        rent: 360_000,
      },
      extras: [
        { name: '新聞図書費', amount: 12_000 },
        { name: '支払手数料', amount: 8_000 },
      ],
      expensesTotal: 665_044,
      net: 4_402_956,
      blueApplied: 650_000,
      income: 3_752_956,
      blueOption: 650_000,
    },
    monthly: {
      sales: [400000, 400000, 400000, 400000, 400000, 400000, 400000, 400000, 400000, 400000, 400000, 668000],
      purchases: Array.from({ length: 12 }, () => 0),
    },
    reduced: { sales: 0, purchases: 0 },
    payroll: [{ name: '佐藤 花子', months: 6, salary: 1_500_000, withholding: 30_000 }],
    depreciation: [
      {
        name: 'ノートPC',
        acquired: '2025-07',
        cost: 240_000,
        guarantee: null,
        base: 240_000,
        method: '定額法',
        usefulLife: 4,
        rate: '0.250',
        months: 6,
        dep: 30_000,
        businessRatio: 100,
        business: 30_000,
        closing: 210_000,
        note: '',
      },
    ],
    bs: {
      opening: {
        cash: 50_000, bank: 800_000, receivable: 0, inventory: 0, fixedAsset: 0,
        deferredAsset: 100_000, payable: 0, cardPayable: 0, deposit: 0, capital: 950_000,
      },
      closing: {
        cash: 80_000, bank: 2_100_000, receivable: 350_000, inventory: 0, fixedAsset: 210_000,
        deferredAsset: 100_000, ownerDraw: 1_800_000, payable: 0, cardPayable: 120_000,
        deposit: 15_000, ownerCredit: 200_000, capital: -97_956, profit: 4_402_956,
      },
    },
  };
}

describe('buildKessanshoXtx: e-Tax申告等データの生成', () => {
  const xml = buildKessanshoXtx(fixture());

  it('手続RKO0010 v25.0.0・帳票KOA210 v11.0 の構造で出力する', () => {
    expect(xml).toContain('<RKO0010 id="RKO0010" VR="25.0.0">');
    expect(xml).toContain('<KOA210 VR="11.0"');
    expect(xml).toContain('softNM="申告スナップ"');
    expect(xml).toContain('<TETSUZUKI ID="TETSUZUKI"><procedure_CD>RKO0010</procedure_CD>');
  });

  it('年分・氏名等はIT部に置き、帳票側はIDREFで参照する', () => {
    expect(xml).toContain('<NENBUN ID="NENBUN"><gen:era>5</gen:era><gen:yy>7</gen:yy></NENBUN>');
    expect(xml).toContain('<AMA00000 IDREF="NENBUN"/>');
    expect(xml).toContain('<AMB00040 IDREF="NOZEISHA_NM"/>');
    expect(xml).not.toContain('<AMB00040>山田'); // 値は帳票側に重複させない
  });

  it('損益計算書・月別・減価償却・貸借対照表の金額が入る', () => {
    expect(xml).toContain('<AMF00100>5068000</AMF00100>'); // 売上①
    expect(xml).toContain('<AMF00380>665044</AMF00380>'); // 経費計㉜
    expect(xml).toContain('<AMF00530>3752956</AMF00530>'); // 所得㊺
    expect(xml).toContain('<AMF00930>668000</AMF00930>'); // 12月売上
    expect(xml).toContain('<AMF00355><AMF00060>新聞図書費</AMF00060><AMF00360>12000</AMF00360></AMF00355>');
    expect(xml).toContain('<AMF01690>0.250</AMF01690>'); // 償却率
    expect(xml).toContain('<AMF01760>100.00</AMF01760>'); // 事業専用割合
    expect(xml).toContain('<AMG00750>4402956</AMG00750>'); // B/S 青色控除前所得
    expect(xml).toContain('<AMG00030>開業費</AMG00030>'); // B/S 追加科目
    // 期末合計は貸借一致(資産 = 負債・資本)。マイナスの元入金もそのまま出力される
    expect(xml).toContain('<AMG00440>4640000</AMG00440>');
    expect(xml).toContain('<AMG00740>-97956</AMG00740>');
    expect(xml).toContain('<AMG00760>4640000</AMG00760>');
  });

  it('0円の任意項目は出力しない(様式の空欄)', () => {
    expect(xml).not.toContain('<AMF00190>'); // 租税公課0円
    expect(xml).not.toContain('<AMF00610>'); // 仕入のない月
  });

  it('XMLとして整形式で、特殊文字はエスケープされる', () => {
    const d = fixture();
    d.issuer = { ...issuer, name: '山田<&>商店', yago: '' };
    const x = buildKessanshoXtx(d);
    expect(x).toContain('山田&lt;&amp;&gt;商店');
    expect(x).not.toContain('<NOZEISHA_YAGO'); // 空の任意項目は出さない
  });

  it('減価償却8行目以降は次葉合計へ、給料5人目以降は「その他」へまとめる', () => {
    const d = fixture();
    d.depreciation = Array.from({ length: 9 }, (_, i) => ({
      ...d.depreciation[0], name: `資産${i + 1}`, dep: 10_000, business: 10_000, closing: 1_000,
    }));
    d.payroll = Array.from({ length: 6 }, (_, i) => ({
      name: `従業員${i + 1}`, months: 12, salary: 100_000, withholding: 1_000,
    }));
    const x = buildKessanshoXtx(d);
    expect((x.match(/<AMF01600>/g) ?? []).length).toBe(7);
    expect(x).toContain('<AMF01793>20000</AMF01793>'); // 次葉2行分の償却費
    expect(x).toContain('<AMF01810>90000</AMF01810>'); // 計は全9行分
    expect((x.match(/<AMF01080>/g) ?? []).length).toBe(4);
    expect(x).toContain('<AMF01180>2</AMF01180>'); // その他2名
    expect(x).toContain('<AMF01280>600000</AMF01280>'); // 給料計は6名分
  });

  it('文字数上限を超える値は様式のmaxLengthで切り詰める(回帰: 資産名16字)', () => {
    const d = fixture();
    d.depreciation[0].name = 'ノートPC(MacBook Pro)'; // 18字 → 16字
    const x = buildKessanshoXtx(d);
    expect(x).toContain('<AMF01610>ノートPC(MacBook Pr</AMF01610>');
  });

  it('平成取得の資産は元号4で出力する', () => {
    expect(jpEra(2018)).toEqual({ era: 4, yy: 30 });
    const d = fixture();
    d.depreciation[0].acquired = '2018-04';
    const x = buildKessanshoXtx(d);
    expect(x).toContain('<AMF01630><gen:era>4</gen:era><gen:yy>30</gen:yy><gen:mm>4</gen:mm></AMF01630>');
  });

  it('入力チェック: 税務署コード5桁は必須・利用者識別番号は16桁か空', () => {
    expect(etaxInputProblems(issuer)).toEqual([]);
    expect(etaxInputProblems({ ...issuer, zeimushoCode: '' })).toHaveLength(1);
    expect(etaxInputProblems({ ...issuer, etaxId: '123' })).toHaveLength(1);
    expect(etaxInputProblems({ ...issuer, etaxId: '' })).toEqual([]);
  });

  // 国税庁公式XSDでの検証(ローカル環境のみ:
  //   ETAX_XSD_DIR=<XSDツリー> ETAX_XMLLINT=<xmllintパス> npx vitest run lib/etax.test.ts)
  it.runIf(process.env.ETAX_XSD_DIR && process.env.ETAX_XMLLINT)(
    '公式XSD(RKO0010-250)に対して valid である',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'xtx-'));
      const file = join(dir, 'test.xtx');
      writeFileSync(file, xml, 'utf-8');
      const out = execFileSync(
        process.env.ETAX_XMLLINT!,
        ['--noout', '--schema', join(process.env.ETAX_XSD_DIR!, 'shotoku/RKO0010-250.xsd'), file],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      expect(out).toBe(''); // validates はstderr側。エラーがあれば execFileSync が throw する
    },
  );
});
