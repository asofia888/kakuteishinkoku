import { IssuerProfile } from './types';

/**
 * e-Tax の申告等データ(.xtx)の生成。
 * 手続: RKO0010「所得税及び復興特別所得税申告」v25.0.0(令和7年分仕様)に、
 * 帳票 KOA210「年分青色申告決算書(一般用)」v11.0 のみを含める
 * (全帳票が minOccurs=0 のため決算書のみの申告等データはスキーマ上正規。
 *  freee 等の「決算書のみの e-Tax 用ファイル」と同じ構成)。
 *
 * 構造は国税庁公開の XML構造設計書・帳票フィールド仕様書・XMLスキーマ
 * (e-tax09.CAB / e-tax19.CAB)に基づき、生成物は公式 XSD
 * (shotoku/RKO0010-250.xsd)での検証を通している。
 * - 帳票要素は shotoku 名前空間(既定)、era/yy/mm/dd・電話・税務署コード等の
 *   内部要素は general 名前空間(gen:)
 * - 年分・氏名・住所などは IT 部に一度だけ置き、帳票側は IDREF で参照する
 * 読み込み方: e-Taxソフト(インストール版)の「組み込み」→「申告・申請等」。
 */

const SHO = 'http://xml.e-tax.nta.go.jp/XSD/shotoku';
const GEN = 'http://xml.e-tax.nta.go.jp/XSD/general';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

/** 手続・帳票のバージョン(仕様改定時はここを更新して公式XSDで再検証する) */
export const ETAX_VERSIONS = { procedure: '25.0.0', koa210: '11.0', it: '1.5' } as const;

function esc(s: string): string {
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
  return [...s].slice(0, max).join('');
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
    /** 様式の固定科目(⑧〜㉔・㉛)。租税公課の順 */
    fixed: {
      taxes_dues: number;
      shipping: number;
      utilities: number;
      travel: number;
      communication: number;
      advertising: number;
      entertainment: number;
      insurance: number;
      repairs: number;
      supplies: number;
      depreciation: number;
      welfare: number;
      salaries: number;
      outsourcing: number;
      interest: number;
      rent: number;
      misc: number;
    };
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
    .map((e) => `<AMF00355>${tag('AMF00060', e.name.slice(0, 10))}${tag('AMF00360', e.amount)}</AMF00355>`)
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
  const bsOpenLiab = o.payable + o.cardPayable + o.deposit + o.capital;
  const bsCloseLiab =
    c.payable + c.cardPayable + c.deposit + c.ownerCredit + c.capital + c.profit;

  const f = d.pl.fixed;

  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n` +
    `<DATA xmlns="${SHO}" xmlns:gen="${GEN}" xmlns:rdf="${RDF}" id="DATA">\n` +
    `<RKO0010 id="RKO0010" VR="${ETAX_VERSIONS.procedure}">\n` +
    `<CATALOG id="CATALOG"><rdf:RDF><rdf:Description rdf:about=""><rdf:value>所得税及び復興特別所得税申告</rdf:value></rdf:Description></rdf:RDF></CATALOG>\n` +
    `<CONTENTS id="CONTENTS">\n` +
    `<IT id="IT" VR="${ETAX_VERSIONS.it}">\n` +
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
    `<KOA210 VR="${ETAX_VERSIONS.koa210}" page="1" softNM="申告スナップ" sakuseiNM="${esc(iss.name)}" sakuseiDay="${esc(d.createdDate)}">\n` +
    // ── 1ページ目: 損益計算書 ──
    `<KOA210-1>\n` +
    ref('AMA00000', 'NENBUN') +
    `<AMB00000>` +
    tag('AMB00010', iss.address) +
    `<AMB00020>${iss.nameKana ? ref('AMB00030', 'NOZEISHA_NM_KN') : ''}${ref('AMB00040', 'NOZEISHA_NM')}</AMB00020>` +
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
    tag('AMF00190', opt(f.taxes_dues)) +
    tag('AMF00200', opt(f.shipping)) +
    tag('AMF00210', opt(f.utilities)) +
    tag('AMF00220', opt(f.travel)) +
    tag('AMF00230', opt(f.communication)) +
    tag('AMF00240', opt(f.advertising)) +
    tag('AMF00250', opt(f.entertainment)) +
    tag('AMF00260', opt(f.insurance)) +
    tag('AMF00270', opt(f.repairs)) +
    tag('AMF00280', opt(f.supplies)) +
    tag('AMF00290', opt(f.depreciation)) +
    tag('AMF00300', opt(f.welfare)) +
    tag('AMF00310', opt(f.salaries)) +
    tag('AMF00320', opt(f.outsourcing)) +
    tag('AMF00330', opt(f.interest)) +
    tag('AMF00340', opt(f.rent)) +
    extrasXml +
    tag('AMF00370', opt(f.misc)) +
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
    ref('AMF00538', 'NENBUN') +
    `<AMF00540>${iss.nameKana ? ref('AMF00550', 'NOZEISHA_NM_KN') : ''}${ref('AMF00560', 'NOZEISHA_NM')}</AMF00540>\n` +
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
    `<AMF01500>${tag('AMF01520', d.pl.net)}${blueXml}</AMF01500>\n` +
    `</KOA210-2>\n` +
    // ── 3ページ目: 減価償却費の計算 ──
    (d.depreciation.length > 0
      ? `<KOA210-3>\n<AMF01590>` +
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
    `<AMG00490><AMG00500><gen:mm>1</gen:mm><gen:dd>1</gen:dd></AMG00500>${tag('AMG00520', opt(o.payable))}${tag('AMG00540', opt(o.cardPayable))}${tag('AMG00560', opt(o.deposit))}${tag('AMG00600', o.capital)}${tag('AMG00610', bsOpenLiab)}</AMG00490>` +
    `<AMG00620><AMG00630><gen:mm>12</gen:mm><gen:dd>31</gen:dd></AMG00630>${tag('AMG00650', opt(c.payable))}${tag('AMG00670', opt(c.cardPayable))}${tag('AMG00690', opt(c.deposit))}${tag('AMG00730', opt(c.ownerCredit))}${tag('AMG00740', c.capital)}${tag('AMG00750', c.profit)}${tag('AMG00760', bsCloseLiab)}</AMG00620>` +
    `</AMG00450>` +
    `</AMG00000>\n</KOA210-4>\n` +
    `</KOA210>\n</CONTENTS>\n</RKO0010>\n</DATA>\n`;

  return xml;
}
