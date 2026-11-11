import { KESSANSHO_EXPENSES } from './kessansho';
import { IssuerProfile } from './types';

/**
 * e-Tax の申告等データ(.xtx)の生成。
 * 手続: RKO0010「所得税及び復興特別所得税申告」に、
 * 帳票 KOA210「年分青色申告決算書(一般用)」のみを含める
 * (全帳票が minOccurs=0 のため決算書のみの申告等データはスキーマ上正規。
 *  freee 等の「決算書のみの e-Tax 用ファイル」と同じ構成)。
 * 手続・帳票の版は年分ごとに改定されるため、年分ごとの版を ETAX_SPECS に持つ
 * (令和7年分 = 手続 v25.0.0・帳票 v11.0 / 令和8年分 = 手続 v26.0.0・帳票 v12.0)。
 *
 * 構造は国税庁公開の XML構造設計書・帳票フィールド仕様書・XMLスキーマ
 * (e-tax09.CAB / e-tax19.CAB)に基づき、生成物は年分ごとの公式 XSD
 * (令和7年分は shotoku/RKO0010-250.xsd)での検証を通している。
 * - 帳票要素は shotoku 名前空間(既定)、era/yy/mm/dd・電話・税務署コード等の
 *   内部要素は general 名前空間(gen:)
 * - 年分・氏名・住所などは IT 部に一度だけ置き、帳票側は IDREF で参照する
 * 読み込み方: e-Taxソフト(インストール版)の「組み込み」→「申告・申請等」。
 */

const SHO = 'http://xml.e-tax.nta.go.jp/XSD/shotoku';
const GEN = 'http://xml.e-tax.nta.go.jp/XSD/general';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

/** 年分ごとの e-Tax 仕様(手続・帳票の版) */
export interface EtaxSpec {
  /** 手続 RKO0010 の版 */
  procedure: string;
  /** 帳票 KOA210(青色申告決算書・一般用)の版 */
  koa210: string;
  /** IT部の版 */
  it: string;
  /** 検証に使う公式XMLスキーマ(e-tax19.CAB を展開したツリーの中のパス) */
  xsd: string;
  /**
   * 確定版の仕様がまだ公開されていない年分に、その状況を書く(画面にそのまま出す)。
   * これがある年分は、ドラフト版の様式で組み立てはできるが、画面からは出力させない
   */
  draft?: string;
}

/**
 * 年分 → 仕様。手続 RKO0010 と帳票は年分ごとに改定されるため、別の年分の版で出力すると
 * e-Taxソフトで組み込めないか、年分と様式の食い違ったデータになる。
 *
 * 新しい年分に対応する手順:
 * 1. 国税庁の仕様書(XML構造設計書・帳票フィールド仕様書)で前の版との差分を確かめ、
 *    buildKessanshoXtx の様式の分岐を足す
 * 2. 確定版の XMLスキーマ(e-tax19.CAB)で lib/etax.test.ts の検証を通す
 *    (ETAX_XSD_DIR に xsd のファイルがあれば、その年分の検証が自動で動く)
 * 3. 検証できたら draft を外す(画面から出力できるようになる)
 *
 * 令和8年分(2026年分)は 2026年10月30日公開のドラフト版にもとづく
 * (手続 v26.0.0・帳票 KOA210 v12.0・IT部 1.5 はドラフト版の更新履歴・構造設計書・IT部要素一覧で確認)。
 * 帳票 v12.0 でアプリの出力に関わる変更は、年分・氏名の欄が2ページ目から3ページ目へ移ったこと。
 * ほかは出力しない欄の変更(1ページ目に届出事項 AMJ00000、4ページ目に AMM00000 の追加、
 * 追加科目などの繰り返し回数の上限の引き下げ)。確定版で要確認の点:
 * - XMLスキーマはドラフト版に含まれない(RKO0010-260.xsd は従来の命名からの見込み)
 * - ドラフト版から確定版までに様式が変わっていないか
 */
export const ETAX_SPECS: Readonly<Record<number, EtaxSpec>> = {
  2025: { procedure: '25.0.0', koa210: '11.0', it: '1.5', xsd: 'shotoku/RKO0010-250.xsd' },
  2026: {
    procedure: '26.0.0',
    koa210: '12.0',
    it: '1.5',
    xsd: 'shotoku/RKO0010-260.xsd',
    draft:
      '国税庁が公開している仕様がドラフト版の段階で、確定版(XMLスキーマを含む)の公開は2026年11月25日、' +
      'e-Taxソフトでの受付開始は2027年1月4日の予定です',
  },
};

/** 申告等データを出力できる年分(確定版の仕様で検証済みの年分) */
export const ETAX_SUPPORTED_YEARS: readonly number[] = Object.keys(ETAX_SPECS)
  .map(Number)
  .filter((y) => !ETAX_SPECS[y].draft);

/** その年分を出力できるときの仕様(出力できない年分は null)。画面の版表示用 */
export function etaxSpecFor(year: number): EtaxSpec | null {
  return ETAX_SUPPORTED_YEARS.includes(year) ? ETAX_SPECS[year] : null;
}

/** その年分の申告等データを出力できないときの理由(出力できれば null) */
export function etaxYearProblem(year: number): string | null {
  if (ETAX_SUPPORTED_YEARS.includes(year)) return null;
  const label = `令和${year - 2018}年分(${year}年分)`;
  const supported = ETAX_SUPPORTED_YEARS.map((y) => `令和${y - 2018}年分(${y}年分)`).join('・');
  const meanwhile = 'それまでは転記ガイド・様式イメージを見ながら、作成コーナーまたは e-Taxソフトで入力してください';
  const draft = ETAX_SPECS[year]?.draft;
  if (draft) {
    return `${label}の申告等データは、まだ出力できません。${draft}。確定版で出力を検証してから対応します。${meanwhile}`;
  }
  return year > Math.max(...ETAX_SUPPORTED_YEARS)
    ? `${label}の e-Tax 仕様にはまだ対応していません(対応は${supported})。` +
        `国税庁が新しい年分の仕様を公開したら対応します。${meanwhile}`
    : `${label}の e-Tax 仕様には対応していません(対応は${supported})`;
}

/**
 * e-Tax の文字列型(general:str)で使えない文字を直す。
 * 使える文字は基本ラテン・ひらがな・全角カタカナ・漢字・全角英数記号など。
 * 半角カタカナ(銀行明細由来の「ｶﾌﾞｼｷｶﾞｲｼｬ」など)や絵文字が1文字でもあると
 * 申告等データ全体がスキーマ違反になるため、NFKC で半角カナを全角に揃え、
 * それでも使えない文字は取り除く。
 */
export function etaxText(s: string): string {
  return [...s.normalize('NFKC')].filter(isEtaxChar).join('');
}

function isEtaxChar(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  if (c === 0x09 || c === 0x0a || c === 0x0d) return true;
  const inRange = (from: number, to: number) => c >= from && c <= to;
  return (
    inRange(0x20, 0x7e) || // 基本ラテン(制御文字を除く)
    inRange(0xa0, 0xff) || // ラテン1補助(制御文字を除く)
    inRange(0x370, 0x4ff) || // ギリシャ・キリル
    inRange(0x2000, 0x206f) || // 一般句読点
    inRange(0x2150, 0x21ff) || // 数字の形・矢印
    inRange(0x2200, 0x22ff) || // 数学記号
    inRange(0x2460, 0x24ff) || // 囲み英数字
    inRange(0x2500, 0x257f) || // 罫線
    inRange(0x25a0, 0x25ff) || // 幾何学模様
    inRange(0x3000, 0x30ff) || // CJK記号・ひらがな・カタカナ
    inRange(0x3200, 0x33ff) || // 囲みCJK・CJK互換
    inRange(0x4e00, 0x9fff) || // CJK統合漢字
    inRange(0xf900, 0xfaff) || // CJK互換漢字
    (inRange(0xff00, 0xffef) && !inRange(0xff66, 0xff9f)) // 全角形(半角カタカナを除く)
  );
}

function esc(raw: string): string {
  const s = etaxText(raw);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 金額等の任意項目: null は出力しない(様式の空欄) */
function tag(name: string, v: number | string | null): string {
  if (v === null) return '';
  return `<${name}>${typeof v === 'string' ? esc(v) : v}</${name}>`;
}

/** 0 は空欄扱いにする任意項目 */
function opt(v: number): number | null {
  return v > 0 ? v : null;
}

/** IT部の項目を参照する空要素(値は IT 部にのみ置く) */
function ref(name: string, idref: string): string {
  return `<${name} IDREF="${idref}"/>`;
}

/** 様式の文字数上限(XSDのmaxLength)に合わせて切り詰める */
function cut(s: string, max: number): string {
  // 文字数は使える文字に直してから数える(直すと文字数が変わることがあるため)
  return [...etaxText(s)].slice(0, max).join('');
}

/** 和暦(era: 3=昭和 4=平成 5=令和) */
export function jpEra(year: number): { era: number; yy: number } {
  if (year >= 2019) return { era: 5, yy: year - 2018 };
  if (year >= 1989) return { era: 4, yy: year - 1988 };
  return { era: 3, yy: year - 1925 };
}

function eraYY(year: number): string {
  const { era, yy } = jpEra(year);
  return `<gen:era>${era}</gen:era><gen:yy>${yy}</gen:yy>`;
}

function telParts(tel: string): string {
  // 090-0000-0000 / 03(0000)0000 などを3分割。分割できなければ加入者番号のみ
  const digits = tel.split(/[-()\s]+/).filter((p) => /^\d+$/.test(p));
  if (digits.length >= 3) {
    return `<gen:tel1>${digits[0]}</gen:tel1><gen:tel2>${digits[1]}</gen:tel2><gen:tel3>${digits.slice(2).join('')}</gen:tel3>`;
  }
  const all = tel.replace(/\D/g, '');
  return all ? `<gen:tel3>${all.slice(-4)}</gen:tel3>` : '';
}

/** 減価償却1行分(青色申告決算書3ページ目の様式の列) */
export interface EtaxDepreciationRow {
  name: string;
  /** 取得年月 YYYY-MM */
  acquired: string;
  cost: number;
  /** 償却保証額(定率法のみ) */
  guarantee: number | null;
  /** 償却の基礎になる金額 */
  base: number;
  /** 償却方法の表示(定額法・定率法など) */
  method: string;
  usefulLife: number | null;
  /** 償却率(0.250 のような文字列)。一括償却等は null */
  rate: string | null;
  months: number;
  /** 本年分の普通償却費 */
  dep: number;
  /** 事業専用割合(%) */
  businessRatio: number;
  /** 本年分の必要経費算入額 */
  business: number;
  /** 未償却残高(期末) */
  closing: number;
  note: string;
}

/** 地代家賃の内訳1行(支払先ごと。様式は2行まで) */
export interface EtaxRentRow {
  name: string;
  address: string;
  /** 賃借物件(14字まで) */
  property: string;
  /** 本年中の賃借料(按分前) */
  rent: number;
  /** 左の賃借料のうち必要経費算入額 */
  business: number;
}

/** 給料賃金の内訳1行(従業員ごと) */
export interface EtaxPayrollRow {
  name: string;
  months: number;
  salary: number;
  withholding: number;
}

export interface KessanshoInput {
  year: number;
  issuer: IssuerProfile;
  /** 作成日(YYYY-MM-DD) */
  createdDate: string;
  pl: {
    sales: number;
    inventoryOpening: number;
    purchases: number;
    inventoryClosing: number;
    costOfSales: number;
    grossProfit: number;
    /** 勘定科目ID → 経費計上額。様式の固定欄(⑧〜㉔・㉛)は KESSANSHO_EXPENSES で対応付ける */
    expenseByAccount: Record<string, number>;
    /** 空欄科目(㉕〜㉚)に書く追加科目。最大6件 */
    extras: { name: string; amount: number }[];
    expensesTotal: number;
    net: number;
    blueApplied: number;
    income: number;
    /** 選択している青色申告特別控除の枠(65万/55万/10万) */
    blueOption: number;
  };
  monthly: { sales: number[]; purchases: number[] };
  /** 軽減税率対象の売上・仕入(税区分 taxable8 の集計。0なら出力しない) */
  reduced: { sales: number; purchases: number };
  payroll: EtaxPayrollRow[];
  /** 地代家賃の内訳(3件目以降は様式に欄がないため出力しない) */
  rent?: EtaxRentRow[];
  depreciation: EtaxDepreciationRow[];
  bs: {
    opening: {
      cash: number;
      bank: number;
      receivable: number;
      inventory: number;
      fixedAsset: number;
      deferredAsset: number;
      payable: number;
      cardPayable: number;
      /** 借入金 */
      loan: number;
      deposit: number;
      capital: number;
    };
    closing: {
      cash: number;
      bank: number;
      receivable: number;
      inventory: number;
      fixedAsset: number;
      deferredAsset: number;
      ownerDraw: number;
      payable: number;
      cardPayable: number;
      /** 借入金 */
      loan: number;
      deposit: number;
      ownerCredit: number;
      capital: number;
      profit: number;
    };
  };
}

/** 利用者識別番号・税務署コードの形式チェック(ダウンロード前のガード用) */
export function etaxInputProblems(issuer: IssuerProfile): string[] {
  const problems: string[] = [];
  if (!/^\d{5}$/.test(issuer.zeimushoCode)) {
    problems.push('提出先税務署コード(5桁)を入力してください');
  }
  if (issuer.etaxId !== '' && !/^\d{16}$/.test(issuer.etaxId)) {
    problems.push('利用者識別番号は16桁の数字で入力してください(未取得なら空欄)');
  }
  if (!issuer.name.trim()) problems.push('氏名を入力してください(請求書発行の請求元情報と共通)');
  if (!issuer.address.trim()) problems.push('住所を入力してください');
  return problems;
}

/** 青色申告決算書(一般用)のみを含む申告等データ(.xtx)を生成する */
export function buildKessanshoXtx(d: KessanshoInput): string {
  const iss = d.issuer;
  const year = d.year;
  const spec = ETAX_SPECS[year];
  if (!spec) throw new Error(etaxYearProblem(year) ?? `${year}年分の e-Tax 仕様がありません`);
  // 帳票 v12.0(令和8年分)から、年分・氏名の欄が2ページ目から3ページ目の先頭に移った
  const headerOnPage3 = Number(spec.koa210) >= 12;
  /** 氏名欄(フリガナは入力があるときだけ)。値は IT 部にあり、ここは参照だけ */
  const nameRefs = (wrap: string, kana: string, name: string) =>
    `<${wrap}>${iss.nameKana ? ref(kana, 'NOZEISHA_NM_KN') : ''}${ref(name, 'NOZEISHA_NM')}</${wrap}>`;

  // ── 減価償却: 様式の主表は7行。8行目以降は「次葉合計」欄にまとめる ──
  const depMain = d.depreciation.slice(0, 7);
  const depOverflow = d.depreciation.slice(7);
  const depSum = (rows: EtaxDepreciationRow[], f: (r: EtaxDepreciationRow) => number) =>
    rows.reduce((s, r) => s + f(r), 0);

  const depRowXml = (r: EtaxDepreciationRow) => {
    const [ay, am] = r.acquired.split('-').map(Number);
    const { era, yy } = jpEra(ay);
    return (
      '<AMF01600>' +
      tag('AMF01610', cut(r.name, 16)) +
      `<AMF01630><gen:era>${era}</gen:era><gen:yy>${yy}</gen:yy><gen:mm>${am}</gen:mm></AMF01630>` +
      tag('AMF01640', r.cost) +
      tag('AMF01645', r.guarantee) +
      tag('AMF01650', r.base) +
      tag('AMF01660', cut(r.method, 10)) +
      tag('AMF01670', r.usefulLife) +
      (r.rate !== null ? `<AMF01680><AMF01690>${r.rate}</AMF01690></AMF01680>` : '') +
      tag('AMF01720', r.months) +
      tag('AMF01730', r.dep) +
      tag('AMF01750', r.dep) +
      tag('AMF01760', r.businessRatio.toFixed(2)) +
      tag('AMF01770', r.business) +
      tag('AMF01780', r.closing) +
      tag('AMF01790', r.note ? cut(r.note, 15) : null) +
      '</AMF01600>'
    );
  };

  // ── 給料賃金の内訳: 主表4名。5名目以降は「その他」欄にまとめる ──
  const payMain = d.payroll.slice(0, 4);
  const payOthers = d.payroll.slice(4);
  const paySalary = (rows: EtaxPayrollRow[]) => rows.reduce((s, r) => s + r.salary, 0);
  const payWh = (rows: EtaxPayrollRow[]) => rows.reduce((s, r) => s + r.withholding, 0);
  const payMonths = (rows: EtaxPayrollRow[]) => rows.reduce((s, r) => s + r.months, 0);

  const payRowXml = (r: EtaxPayrollRow) =>
    '<AMF01080>' +
    tag('AMF01090', r.name) +
    tag('AMF01110', Math.min(12, Math.max(1, r.months))) +
    `<AMF01120>${tag('AMF01130', r.salary)}${tag('AMF01150', r.salary)}</AMF01120>` +
    tag('AMF01160', opt(r.withholding)) +
    '</AMF01080>';

  // ── 地代家賃の内訳(2ページ目。様式は2行) ──
  const rentXml = (d.rent ?? [])
    .slice(0, 2)
    .map(
      (r) =>
        '<AMF02120>' +
        `<AMF02130>${r.address ? tag('AMF02140', r.address) : ''}${tag('AMF02150', r.name)}</AMF02130>` +
        (r.property ? tag('AMF02160', cut(r.property, 14)) : '') +
        `<AMF02170>${tag('AMF02200', r.rent)}</AMF02170>` +
        tag('AMF02210', r.business) +
        '</AMF02120>',
    )
    .join('');

  // ── 月別売上・仕入(2ページ目) ──
  const monthWraps = [
    'AMF00590', 'AMF00620', 'AMF00650', 'AMF00680', 'AMF00710', 'AMF00740',
    'AMF00770', 'AMF00800', 'AMF00830', 'AMF00860', 'AMF00890', 'AMF00920',
  ];
  const monthTags: [string, string][] = [
    ['AMF00600', 'AMF00610'], ['AMF00630', 'AMF00640'], ['AMF00660', 'AMF00670'],
    ['AMF00690', 'AMF00700'], ['AMF00720', 'AMF00730'], ['AMF00750', 'AMF00760'],
    ['AMF00780', 'AMF00790'], ['AMF00810', 'AMF00820'], ['AMF00840', 'AMF00850'],
    ['AMF00870', 'AMF00880'], ['AMF00900', 'AMF00910'], ['AMF00930', 'AMF00940'],
  ];
  const monthlyXml = monthWraps
    .map((wrap, i) => {
      const s = opt(d.monthly.sales[i] ?? 0);
      const p = opt(d.monthly.purchases[i] ?? 0);
      if (s === null && p === null) return '';
      return `<${wrap}>${tag(monthTags[i][0], s)}${tag(monthTags[i][1], p)}</${wrap}>`;
    })
    .join('');

  // ── 経費の空欄科目(最大6) ──
  const extrasXml = d.pl.extras
    .slice(0, 6)
    .filter((e) => e.amount > 0)
    .map((e) => `<AMF00355>${tag('AMF00060', cut(e.name, 10))}${tag('AMF00360', e.amount)}</AMF00355>`)
    .join('');

  // ── 青色申告特別控除(65万/55万は⑧⑨、10万は「上記以外」欄) ──
  const blueXml =
    d.pl.blueOption >= 550_000
      ? `<AMF01530>${tag('AMF01540', d.pl.blueApplied)}${tag('AMF01550', d.pl.blueApplied)}</AMF01530>`
      : `<AMF01560>${tag('AMF01570', d.pl.blueApplied)}${tag('AMF01580', d.pl.blueApplied)}</AMF01560>`;

  // ── 貸借対照表(4ページ目)。開業費(繰延資産)は資産の追加科目欄に載せる ──
  const o = d.bs.opening;
  const c = d.bs.closing;
  const bsExtraXml =
    o.deferredAsset > 0 || c.deferredAsset > 0
      ? `<AMG00025>${tag('AMG00030', '開業費')}${tag('AMG00220', opt(o.deferredAsset))}${tag('AMG00420', opt(c.deferredAsset))}</AMG00025>`
      : '';
  const bsOpenTotal =
    o.cash + o.bank + o.receivable + o.inventory + o.fixedAsset + o.deferredAsset;
  const bsCloseTotal =
    c.cash + c.bank + c.receivable + c.inventory + c.fixedAsset + c.deferredAsset + c.ownerDraw;
  const bsOpenLiab = o.payable + o.loan + o.cardPayable + o.deposit + o.capital;
  const bsCloseLiab =
    c.payable + c.loan + c.cardPayable + c.deposit + c.ownerCredit + c.capital + c.profit;

  // 経費の固定欄(⑧〜㉔)は共通定義表の順に出力し、空欄科目(繰返し)を挟んで雑費㉛で締める
  // (XMLスキーマの出現順 = AMF00190..00350, AMF00355×n, AMF00370)
  const exp = (account: string | null) =>
    account !== null ? opt(d.pl.expenseByAccount[account] ?? 0) : null;
  const fixedExpensesXml = KESSANSHO_EXPENSES.filter((e) => e.xtxTag !== 'AMF00370')
    .map((e) => tag(e.xtxTag, exp(e.account)))
    .join('');
  const miscXml = tag('AMF00370', exp('misc'));

  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n` +
    `<DATA xmlns="${SHO}" xmlns:gen="${GEN}" xmlns:rdf="${RDF}" id="DATA">\n` +
    `<RKO0010 id="RKO0010" VR="${spec.procedure}">\n` +
    `<CATALOG id="CATALOG"><rdf:RDF><rdf:Description rdf:about=""><rdf:value>所得税及び復興特別所得税申告</rdf:value></rdf:Description></rdf:RDF></CATALOG>\n` +
    `<CONTENTS id="CONTENTS">\n` +
    `<IT id="IT" VR="${spec.it}">\n` +
    `<ZEIMUSHO ID="ZEIMUSHO"><gen:zeimusho_CD>${esc(iss.zeimushoCode)}</gen:zeimusho_CD>${iss.zeimushoName ? `<gen:zeimusho_NM>${esc(iss.zeimushoName)}</gen:zeimusho_NM>` : ''}</ZEIMUSHO>\n` +
    `<NOZEISHA_ID ID="NOZEISHA_ID">${esc(iss.etaxId)}</NOZEISHA_ID>\n` +
    (iss.nameKana ? `<NOZEISHA_NM_KN ID="NOZEISHA_NM_KN">${esc(iss.nameKana)}</NOZEISHA_NM_KN>\n` : '') +
    `<NOZEISHA_NM ID="NOZEISHA_NM">${esc(iss.name)}</NOZEISHA_NM>\n` +
    `<NOZEISHA_ADR ID="NOZEISHA_ADR">${esc(iss.address)}</NOZEISHA_ADR>\n` +
    (iss.yago ? `<NOZEISHA_YAGO ID="NOZEISHA_YAGO">${esc(cut(iss.yago, 30))}</NOZEISHA_YAGO>\n` : '') +
    (iss.tel ? `<NOZEISHA_TEL ID="NOZEISHA_TEL">${telParts(iss.tel)}</NOZEISHA_TEL>\n` : '') +
    (iss.shokugyo ? `<SHOKUGYO ID="SHOKUGYO">${esc(cut(iss.shokugyo, 20))}</SHOKUGYO>\n` : '') +
    `<TETSUZUKI ID="TETSUZUKI"><procedure_CD>RKO0010</procedure_CD><procedure_NM>所得税及び復興特別所得税申告</procedure_NM></TETSUZUKI>\n` +
    `<NENBUN ID="NENBUN">${eraYY(year)}</NENBUN>\n` +
    `</IT>\n` +
    `<KOA210 VR="${spec.koa210}" page="1" softNM="申告スナップ" sakuseiNM="${esc(iss.name)}" sakuseiDay="${esc(d.createdDate)}">\n` +
    // ── 1ページ目: 損益計算書 ──
    `<KOA210-1>\n` +
    ref('AMA00000', 'NENBUN') +
    `<AMB00000>` +
    tag('AMB00010', iss.address) +
    nameRefs('AMB00020', 'AMB00030', 'AMB00040') +
    (iss.tel ? `<AMB00060><AMB00070>${telParts(iss.tel)}</AMB00070></AMB00060>` : '') +
    (iss.shokugyo ? ref('AMB00090', 'SHOKUGYO') : '') +
    (iss.yago ? ref('AMB00100', 'NOZEISHA_YAGO') : '') +
    `</AMB00000>\n` +
    `<AMF00000><AMF00010>` +
    `<AMF00020><AMF00030><gen:mm>1</gen:mm><gen:dd>1</gen:dd></AMF00030><AMF00040><gen:mm>12</gen:mm><gen:dd>31</gen:dd></AMF00040></AMF00020>` +
    `<AMF00090>\n` +
    tag('AMF00100', d.pl.sales) +
    `<AMF00110>${tag('AMF00120', opt(d.pl.inventoryOpening))}${tag('AMF00130', opt(d.pl.purchases))}${tag('AMF00140', opt(d.pl.inventoryOpening + d.pl.purchases))}${tag('AMF00150', opt(d.pl.inventoryClosing))}${tag('AMF00160', opt(d.pl.costOfSales))}</AMF00110>\n` +
    tag('AMF00170', d.pl.grossProfit) +
    `\n<AMF00180>` +
    fixedExpensesXml +
    extrasXml +
    miscXml +
    tag('AMF00380', d.pl.expensesTotal) +
    `</AMF00180>\n` +
    tag('AMF00390', d.pl.net) +
    tag('AMF00500', d.pl.net) +
    tag('AMF00510', d.pl.blueApplied) +
    tag('AMF00530', d.pl.income) +
    `</AMF00090></AMF00010></AMF00000>\n` +
    `</KOA210-1>\n` +
    // ── 2ページ目: 月別・給料賃金の内訳・青色申告特別控除 ──
    `<KOA210-2>\n` +
    (headerOnPage3 ? '' : `${ref('AMF00538', 'NENBUN')}${nameRefs('AMF00540', 'AMF00550', 'AMF00560')}\n`) +
    `<AMF00580>${monthlyXml}<AMF00970>${tag('AMF00980', d.pl.sales)}${tag('AMF00990', opt(d.pl.purchases))}</AMF00970>` +
    (d.reduced.sales > 0 || d.reduced.purchases > 0
      ? `<AMF00993>${tag('AMF00995', opt(d.reduced.sales))}${tag('AMF00997', opt(d.reduced.purchases))}</AMF00993>`
      : '') +
    `</AMF00580>\n` +
    (d.payroll.length > 0
      ? `<AMF01070>${payMain.map(payRowXml).join('')}` +
        (payOthers.length > 0
          ? `<AMF01170>${tag('AMF01180', payOthers.length)}${tag('AMF01190', payMonths(payOthers))}<AMF01200>${tag('AMF01210', paySalary(payOthers))}${tag('AMF01230', paySalary(payOthers))}</AMF01200>${tag('AMF01240', opt(payWh(payOthers)))}</AMF01170>`
          : '') +
        `<AMF01250>${tag('AMF01260', payMonths(d.payroll))}<AMF01270>${tag('AMF01280', paySalary(d.payroll))}${tag('AMF01300', paySalary(d.payroll))}</AMF01270>${tag('AMF01310', opt(payWh(d.payroll)))}</AMF01250></AMF01070>\n`
      : '') +
    rentXml +
    `<AMF01500>${tag('AMF01520', d.pl.net)}${blueXml}</AMF01500>\n` +
    `</KOA210-2>\n` +
    // ── 3ページ目: 減価償却費の計算(v12.0 からは先頭に年分・氏名) ──
    (d.depreciation.length > 0
      ? `<KOA210-3>\n` +
        (headerOnPage3 ? `${ref('AMK00000', 'NENBUN')}${nameRefs('AML00000', 'AML00010', 'AML00020')}\n` : '') +
        `<AMF01590>` +
        depMain.map(depRowXml).join('\n') +
        (depOverflow.length > 0
          ? `<AMF01791>${tag('AMF01792', '次葉合計')}${tag('AMF01793', depSum(depOverflow, (r) => r.dep))}${tag('AMF01795', depSum(depOverflow, (r) => r.dep))}${tag('AMF01796', depSum(depOverflow, (r) => r.business))}${tag('AMF01797', depSum(depOverflow, (r) => r.closing))}</AMF01791>`
          : '') +
        `<AMF01800>${tag('AMF01810', depSum(d.depreciation, (r) => r.dep))}${tag('AMF01830', depSum(d.depreciation, (r) => r.dep))}${tag('AMF01840', depSum(d.depreciation, (r) => r.business))}${tag('AMF01850', depSum(d.depreciation, (r) => r.closing))}</AMF01800>` +
        `</AMF01590>\n</KOA210-3>\n`
      : '') +
    // ── 4ページ目: 貸借対照表 ──
    `<KOA210-4>\n<AMG00000>` +
    `<AMG00010>${eraYY(year)}<gen:mm>12</gen:mm><gen:dd>31</gen:dd></AMG00010>` +
    `<AMG00020>${bsExtraXml}` +
    `<AMG00040><AMG00050><gen:mm>1</gen:mm><gen:dd>1</gen:dd></AMG00050>${tag('AMG00060', opt(o.cash))}${tag('AMG00090', opt(o.bank))}${tag('AMG00110', opt(o.receivable))}${tag('AMG00130', opt(o.inventory))}${tag('AMG00200', opt(o.fixedAsset))}${tag('AMG00230', bsOpenTotal)}</AMG00040>` +
    `<AMG00240><AMG00250><gen:mm>12</gen:mm><gen:dd>31</gen:dd></AMG00250>${tag('AMG00260', opt(c.cash))}${tag('AMG00290', opt(c.bank))}${tag('AMG00310', opt(c.receivable))}${tag('AMG00330', opt(c.inventory))}${tag('AMG00400', opt(c.fixedAsset))}${tag('AMG00430', opt(c.ownerDraw))}${tag('AMG00440', bsCloseTotal)}</AMG00240>` +
    `</AMG00020>` +
    `<AMG00450>` +
    `<AMG00490><AMG00500><gen:mm>1</gen:mm><gen:dd>1</gen:dd></AMG00500>${tag('AMG00520', opt(o.payable))}${tag('AMG00530', opt(o.loan))}${tag('AMG00540', opt(o.cardPayable))}${tag('AMG00560', opt(o.deposit))}${tag('AMG00600', o.capital)}${tag('AMG00610', bsOpenLiab)}</AMG00490>` +
    `<AMG00620><AMG00630><gen:mm>12</gen:mm><gen:dd>31</gen:dd></AMG00630>${tag('AMG00650', opt(c.payable))}${tag('AMG00660', opt(c.loan))}${tag('AMG00670', opt(c.cardPayable))}${tag('AMG00690', opt(c.deposit))}${tag('AMG00730', opt(c.ownerCredit))}${tag('AMG00740', c.capital)}${tag('AMG00750', c.profit)}${tag('AMG00760', bsCloseLiab)}</AMG00620>` +
    `</AMG00450>` +
    `</AMG00000>\n</KOA210-4>\n` +
    `</KOA210>\n</CONTENTS>\n</RKO0010>\n</DATA>\n`;

  return xml;
}
