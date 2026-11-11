import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildKessanshoXtx,
  ETAX_SPECS,
  ETAX_SUPPORTED_YEARS,
  etaxInputProblems,
  etaxSpecFor,
  etaxText,
  etaxYearProblem,
  jpEra,
  KessanshoInput,
} from './etax';
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

function fixture(year = 2025): KessanshoInput {
  return {
    year, // 既定は令和7年分
    issuer,
    createdDate: `${year + 1}-03-10`,
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
        acquired: `${year}-07`,
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
        deferredAsset: 100_000, payable: 0, cardPayable: 0, loan: 0, deposit: 0, capital: 950_000,
      },
      closing: {
        cash: 80_000, bank: 2_100_000, receivable: 350_000, inventory: 0, fixedAsset: 210_000,
        deferredAsset: 100_000, ownerDraw: 1_800_000, payable: 0, cardPayable: 120_000,
        loan: 0, deposit: 15_000, ownerCredit: 200_000, capital: -97_956, profit: 4_402_956,
      },
    },
  };
}

/** 地代家賃の内訳あり・半角カナや絵文字を含む入力(スキーマで使えない文字の補正を確かめる) */
function rentFixture(year = 2025): KessanshoInput {
  const d = fixture(year);
  d.issuer = { ...d.issuer, yago: 'ﾔﾏﾀﾞ ﾃﾞｻﾞｲﾝ🎨' };
  d.depreciation[0].name = 'ﾉｰﾄPC ㈱ﾃｽﾄ';
  d.rent = [
    { name: 'ﾔﾏﾀﾞﾌﾄﾞｳｻﾝ(株)', address: '東京都新宿区西新宿１－１', property: '自宅兼事務所(2階の一室と倉庫)', rent: 1_200_000, business: 480_000 },
    { name: '月極駐車場', address: '', property: '駐車場', rent: 180_000, business: 180_000 },
    { name: '3件目', address: '', property: '倉庫', rent: 1, business: 1 },
  ];
  return d;
}

/** 借入金ありの貸借対照表(期首200万・期末150万。借入れた資金は預金にある) */
function loanFixture(year = 2025): KessanshoInput {
  const d = fixture(year);
  d.bs.opening = { ...d.bs.opening, loan: 2_000_000, bank: d.bs.opening.bank + 2_000_000 };
  d.bs.closing = { ...d.bs.closing, loan: 1_500_000, bank: d.bs.closing.bank + 1_500_000 };
  return d;
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

  it('借入金は期首 AMG00530・期末 AMG00660 に出力し、負債・資本の合計に含める', () => {
    const x = buildKessanshoXtx(loanFixture());
    expect(x).toContain('<AMG00530>2000000</AMG00530>');
    expect(x).toContain('<AMG00660>1500000</AMG00660>');
    // 期首・期末とも 資産合計 = 負債・資本合計
    expect(x).toContain('<AMG00230>2950000</AMG00230>');
    expect(x).toContain('<AMG00610>2950000</AMG00610>');
    expect(x).toContain('<AMG00440>6140000</AMG00440>');
    expect(x).toContain('<AMG00760>6140000</AMG00760>');
    // 借入金がなければ欄を出さない(様式の空欄)
    expect(xml).not.toContain('<AMG00530>');
  });

  it('地代家賃の内訳: 支払先・物件(14字)・賃借料・必要経費算入額を2件まで、給料と青色控除の間に出す', () => {
    const x = buildKessanshoXtx(rentFixture());
    expect((x.match(/<AMF02120>/g) ?? []).length).toBe(2);
    expect(x).toContain(
      '<AMF02120><AMF02130><AMF02140>東京都新宿区西新宿1-1</AMF02140><AMF02150>ヤマダフドウサン(株)</AMF02150></AMF02130>' +
        '<AMF02160>自宅兼事務所(2階の一室と倉</AMF02160><AMF02170><AMF02200>1200000</AMF02200></AMF02170><AMF02210>480000</AMF02210></AMF02120>',
    );
    expect(x).toContain('<AMF02130><AMF02150>月極駐車場</AMF02150></AMF02130>'); // 住所なしは省略
    expect(x.indexOf('<AMF02120>')).toBeLessThan(x.indexOf('<AMF01500>'));
  });

  it('e-Taxで使えない文字: 半角カナは全角へ、絵文字は取り除く', () => {
    expect(etaxText('ﾔﾏﾀﾞ ﾃﾞｻﾞｲﾝ🎨')).toBe('ヤマダ デザイン');
    expect(etaxText('ＡＢＣ１２３')).toBe('ABC123');
    const x = buildKessanshoXtx(rentFixture());
    expect(x).toContain('<NOZEISHA_YAGO ID="NOZEISHA_YAGO">ヤマダ デザイン</NOZEISHA_YAGO>');
    expect(x).toContain('<AMF01610>ノートPC (株)テスト</AMF01610>');
    expect(x).not.toMatch(/[ｦ-ﾟ]/);
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

});

describe('buildKessanshoXtx: 令和8年分(手続 v26.0.0・帳票 KOA210 v12.0。ドラフト版の仕様)', () => {
  const xml = buildKessanshoXtx(fixture(2026));
  const page = (x: string, n: number) => x.slice(x.indexOf(`<KOA210-${n}>`), x.indexOf(`</KOA210-${n}>`));

  it('手続・帳票の版と年分が令和8年分になる', () => {
    expect(xml).toContain('<RKO0010 id="RKO0010" VR="26.0.0">');
    expect(xml).toContain('<KOA210 VR="12.0"');
    expect(xml).toContain('<NENBUN ID="NENBUN"><gen:era>5</gen:era><gen:yy>8</gen:yy></NENBUN>');
    expect(xml).toContain('<AMG00010><gen:era>5</gen:era><gen:yy>8</gen:yy><gen:mm>12</gen:mm><gen:dd>31</gen:dd></AMG00010>');
  });

  it('2ページ目から年分・氏名の欄がなくなり、月別売上から始まる', () => {
    expect(xml).not.toContain('AMF00538');
    expect(xml).not.toContain('AMF00540');
    expect(page(xml, 2)).toMatch(/^<KOA210-2>\n<AMF00580>/);
  });

  it('3ページ目の先頭に年分・氏名(IDREF 参照)を置き、そのあとに減価償却費の計算が続く', () => {
    expect(page(xml, 3)).toMatch(
      /^<KOA210-3>\n<AMK00000 IDREF="NENBUN"\/><AML00000><AML00010 IDREF="NOZEISHA_NM_KN"\/><AML00020 IDREF="NOZEISHA_NM"\/><\/AML00000>\n<AMF01590>/,
    );
    // フリガナが未入力なら、参照先のない欄は出さない
    const d = fixture(2026);
    d.issuer = { ...issuer, nameKana: '' };
    const noKana = buildKessanshoXtx(d);
    expect(noKana).not.toContain('NOZEISHA_NM_KN');
    expect(noKana).toContain('<AML00000><AML00020 IDREF="NOZEISHA_NM"/></AML00000>');
  });

  it('減価償却がなければ3ページ目ごと出さない(年分・氏名だけのページは作らない)', () => {
    const d = fixture(2026);
    d.depreciation = [];
    const x = buildKessanshoXtx(d);
    expect(x).not.toContain('<KOA210-3>');
    expect(x).not.toContain('AMK00000');
  });

  it('1・4ページ目と2ページ目の内訳は令和7年分と同じ並び(版と年分の違いだけ)', () => {
    const same = (x: string) =>
      x
        .replace(/VR="[\d.]+"/g, 'VR=""')
        .replace(/<gen:yy>\d+<\/gen:yy>/g, '<gen:yy/>')
        .replace(/sakuseiDay="[^"]+"/, '');
    const r7 = same(buildKessanshoXtx(rentFixture()));
    const r8 = same(buildKessanshoXtx(rentFixture(2026)));
    for (const n of [1, 4]) expect(page(r8, n)).toBe(page(r7, n));
    expect(page(r8, 2)).toBe(page(r7, 2).replace(/<AMF00538.*<\/AMF00540>\n/, ''));
    expect(page(r8, 3).replace(/<AMK00000.*<\/AML00000>\n/, '')).toBe(page(r7, 3));
  });

  it('令和7年分の出力は変わらない(年分・氏名は2ページ目のまま)', () => {
    const r7 = buildKessanshoXtx(fixture());
    expect(page(r7, 2)).toMatch(
      /^<KOA210-2>\n<AMF00538 IDREF="NENBUN"\/><AMF00540><AMF00550 IDREF="NOZEISHA_NM_KN"\/><AMF00560 IDREF="NOZEISHA_NM"\/><\/AMF00540>\n<AMF00580>/,
    );
    expect(page(r7, 3)).toMatch(/^<KOA210-3>\n<AMF01590>/);
    expect(r7).not.toContain('AMK00000');
  });

  it('仕様のない年分は組み立てない(別の年分の版で出力しない)', () => {
    expect(() => buildKessanshoXtx(fixture(2024))).toThrow(/令和6年分.*対応していません/);
    expect(() => buildKessanshoXtx(fixture(2027))).toThrow(/令和9年分.*まだ対応していません/);
  });
});

// 国税庁公式XSDでの検証(ローカル環境のみ:
//   ETAX_XSD_DIR=<XSDツリー> ETAX_XMLLINT=<xmllintパス> npx vitest run lib/etax.test.ts)
// 年分ごとに、その年分の XSD が ETAX_XSD_DIR にあるときだけ動く(なければ skipped と表示される)
describe('公式XSDでの検証', () => {
  const xsdDir = process.env.ETAX_XSD_DIR;
  const xmllint = process.env.ETAX_XMLLINT;
  for (const [y, spec] of Object.entries(ETAX_SPECS)) {
    const year = Number(y);
    const schema = xsdDir ? join(xsdDir, spec.xsd) : '';
    it.runIf(xmllint && schema && existsSync(schema))(
      `令和${year - 2018}年分: ${spec.xsd} に対して valid である(借入金・地代家賃の内訳・半角カナの補正を含む)`,
      () => {
        const dir = mkdtempSync(join(tmpdir(), 'xtx-'));
        for (const [name, content] of [
          ['test.xtx', buildKessanshoXtx(fixture(year))],
          ['loan.xtx', buildKessanshoXtx(loanFixture(year))],
          ['rent.xtx', buildKessanshoXtx(rentFixture(year))],
        ]) {
          const file = join(dir, name);
          writeFileSync(file, content, 'utf-8');
          const out = execFileSync(xmllint!, ['--noout', '--schema', schema, file], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          expect(out).toBe(''); // validates はstderr側。エラーがあれば execFileSync が throw する
        }
      },
    );
  }
});

describe('etaxYearProblem: 対応年分のガード', () => {
  it('令和7年分(2025年分)だけ出力でき、それ以外の年分は理由を返す', () => {
    expect(ETAX_SUPPORTED_YEARS).toEqual([2025]);
    expect(etaxYearProblem(2025)).toBeNull();
    expect(etaxSpecFor(2025)).toMatchObject({ procedure: '25.0.0', koa210: '11.0' });
    expect(etaxYearProblem(2024)).toMatch(/令和6年分.*対応していません/);
    expect(etaxYearProblem(2027)).toMatch(/令和9年分.*まだ対応していません/);
  });

  it('令和8年分は確定版の仕様が出るまで出力させず、公開予定を案内する', () => {
    // ドラフト版の様式(v12.0)で組み立てはできるが、公式XSDで検証できるまで画面からは出さない
    expect(etaxYearProblem(2026)).toMatch(/令和8年分.*まだ出力できません.*ドラフト版.*2026年11月25日.*2027年1月4日/);
    expect(etaxSpecFor(2026)).toBeNull();
  });
});
