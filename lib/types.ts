/** 収入 / 支出 */
export type TxType = 'income' | 'expense';

/** 家事按分の計算タイプ: percent = 事業割合(%) / fixed = 月あたり固定額(円) */
export type AnbunType = 'percent' | 'fixed';

/**
 * 決済手段(どの資産・負債が動いたか)。複式仕訳の相手勘定になる。
 * receivable/payable を選ぶと発生主義の記帳(売掛金・買掛金の計上)になる。
 * deposit は預り金(給与から天引きした源泉所得税など)の計上に使う。
 */
export type FundId = 'bank' | 'cash' | 'card' | 'receivable' | 'payable' | 'deposit' | 'owner';

/** 消費税の税区分(税込経理)。taxable10/8 は取引の収支に応じて課税売上/課税仕入になる */
export type TaxCategory = 'taxable10' | 'taxable8' | 'exempt' | 'none';

/** 取引データ */
export interface Transaction {
  id: string;
  /** 取引日 YYYY-MM-DD */
  date: string;
  /** 正の金額(円) */
  amount: number;
  /** 摘要(取引内容) */
  description: string;
  /** 収入/支出フラグ */
  type: TxType;
  /** 勘定科目ID(lib/accounts.ts)。null = 未仕訳 / 'excluded' = 対象外(プライベート) */
  account: string | null;
  /** ユーザーが内容を確認・承認済みか */
  approved: boolean;
  /** 家事按分適用済みフラグ */
  anbunApplied: boolean;
  /**
   * 事業計上額(円)。家事按分適用後に経費として計上する金額。
   * 按分対象外の取引では amount と同額。amount - businessAmount が「事業主貸」。
   */
  businessAmount: number;
  /** 取込元 */
  source: 'csv' | 'manual' | 'demo';
  createdAt: number;
  /** 決済手段。複式仕訳で現金・普通預金・カード未払金などの相手勘定になる */
  fund: FundId;
  /**
   * 科目が「資金移動(fund_transfer)」のときの相手側の資金。
   * 支出なら移動先(fund → counterFund)、収入なら移動元(counterFund → fund)。
   * 未設定は 預金⇔現金 を自動補完する。
   */
  counterFund?: FundId;
  /** 消費税の税区分。未設定は科目からの自動判定(defaultTaxCategory)を使う */
  taxCategory?: TaxCategory;
  /** 適格請求書(インボイス)の有無。未設定 = あり。課税仕入の税額控除の判定に使う */
  qualifiedInvoice?: boolean;
}

/** 自動仕訳ルール(配列の並び順 = 優先順位) */
export interface Rule {
  id: string;
  /** 摘要に含まれるキーワード(大文字小文字・全角半角は区別しない) */
  keyword: string;
  /** 割り当てる勘定科目ID */
  account: string;
}

/** 家事按分設定(勘定科目ごとに1件) */
export interface AnbunSetting {
  id: string;
  /** 対象の勘定科目ID(経費のみ) */
  account: string;
  /** 計算タイプ */
  type: AnbunType;
  /** percent: 事業割合 1〜100(%) / fixed: 月あたりの経費計上上限額(円) */
  value: number;
  /** 按分割合の算定根拠メモ(「床面積 20㎡/50㎡」等。税務調査で説明できるよう残す) */
  memo?: string;
}

/**
 * 年初(1/1)時点の残高(円)。貸借対照表の期首になる。
 * 元入金は「資産合計 - 負債合計」で自動算出される。
 */
export interface OpeningBalance {
  year: number;
  /** 現金 */
  cash: number;
  /** 普通預金 */
  bank: number;
  /** 売掛金 */
  receivable: number;
  /** クレジットカード未払金 */
  card: number;
  /** 買掛金・その他未払金 */
  payable: number;
  /** 預り金(未納付の源泉所得税など) */
  deposit: number;
}

/** 消費税の設定 */
export interface TaxSettings {
  /** 課税事業者か。false(免税事業者)の場合、消費税ページは参考表示になる */
  taxable: boolean;
  /** 納付税額の計算方式 */
  method: 'general' | 'simplified' | 'special20';
  /** 簡易課税の事業区分(1〜6)。みなし仕入率を決める */
  simplifiedType: 1 | 2 | 3 | 4 | 5 | 6;
}

export const DEFAULT_TAX_SETTINGS: TaxSettings = {
  taxable: false,
  method: 'general',
  simplifiedType: 5,
};

/** 請求書の明細行 */
export interface InvoiceItem {
  id: string;
  /** 品目・内容 */
  description: string;
  /** 数量(1.5時間のような小数も可) */
  quantity: number;
  /** 単価(円)。税込/税抜は請求書側の taxIncluded に従う */
  unitPrice: number;
  /** 適用税率。0 = 非課税・対象外 */
  taxRate: 10 | 8 | 0;
}

/** 請求書 */
export interface Invoice {
  id: string;
  /** 請求書番号(例: 2026-001) */
  number: string;
  /** 発行日 YYYY-MM-DD */
  issueDate: string;
  /** 支払期限 YYYY-MM-DD */
  dueDate: string;
  /** 請求先名 */
  client: string;
  /** 敬称(御中 / 様) */
  clientSuffix: string;
  /** 件名 */
  title: string;
  items: InvoiceItem[];
  /** 単価が税込か(false = 税抜が標準) */
  taxIncluded: boolean;
  /** 源泉徴収(10.21% / 100万円超部分は20.42%)を差し引くか */
  withholding: boolean;
  /** 備考 */
  notes: string;
  /** 売掛金として計上した取引ID(存在チェックで「計上済み」を判定) */
  linkedTxIds?: string[];
  /** 入金確認日(消し込み)。設定すると未回収一覧から外れる */
  paidDate?: string;
  createdAt: number;
}

/** 請求元(自分)の情報。請求書の発行者欄に印字される */
export interface IssuerProfile {
  /** 氏名・屋号 */
  name: string;
  /** 適格請求書発行事業者の登録番号(T+13桁。未登録は空) */
  invoiceRegNumber: string;
  address: string;
  tel: string;
  email: string;
  /** 振込先(自由記述・複数行可) */
  bankInfo: string;
  /** 氏名フリガナ(e-Tax用) */
  nameKana: string;
  /** 屋号(e-Tax用) */
  yago: string;
  /** 業種名(e-Tax用) */
  shokugyo: string;
  /** e-Taxの利用者識別番号(16桁。未取得は空) */
  etaxId: string;
  /** 提出先税務署コード(5桁。e-Taxデータ出力に必須) */
  zeimushoCode: string;
  /** 提出先税務署名(「新宿」など。「税務署」は不要) */
  zeimushoName: string;
}

export const DEFAULT_ISSUER: IssuerProfile = {
  name: '',
  invoiceRegNumber: '',
  address: '',
  tel: '',
  email: '',
  bankInfo: '',
  nameKana: '',
  yago: '',
  shokugyo: '',
  etaxId: '',
  zeimushoCode: '',
  zeimushoName: '',
};

/**
 * 減価償却の方法。
 * - straight: 定額法(個人の法定償却方法。平成19年4月以後取得の資産)
 * - lump3: 一括償却資産(取得価額10万〜20万円未満。3年均等・月割りなし)
 * - immediate: 少額減価償却資産の特例(青色申告・30万円未満・年合計300万円まで。全額その年の経費)
 * - deferred: 繰延資産(開業費・開発費など)。任意償却で、年ごとの償却額を自由に決められる
 */
export type DepreciationMethod = 'straight' | 'declining' | 'lump3' | 'immediate' | 'deferred';

/** 固定資産(減価償却資産)台帳の1件 */
export interface FixedAsset {
  id: string;
  /** 資産の名称(例: ノートPC MacBook Pro) */
  name: string;
  /** 取得日(事業供用日)YYYY-MM-DD */
  acquiredDate: string;
  /** 取得価額(円) */
  cost: number;
  method: DepreciationMethod;
  /** 耐用年数(定額法のみ使用。2〜100年) */
  usefulLife: number;
  /** 事業専用割合(%)1〜100。私用分の償却費は事業主貸になる */
  businessRatio: number;
  /** メモ(型番・中古の見積耐用年数の根拠など) */
  memo?: string;
  /**
   * 除却・売却日。設定するとその月まで月割償却して停止する。
   * 除却損・売却損益は自動計上しない(個人の事業用資産の売却は譲渡所得になるため)。
   */
  disposedDate?: string;
  /**
   * 繰延資産(method='deferred')の年ごとの任意償却額。
   * 開業費は好きな年に好きな額を償却できる(全額の年もあれば0の年もある)。
   */
  deferredDep?: { year: number; amount: number }[];
  createdAt: number;
}

/** 年末(12/31)時点の棚卸資産(商品・製品・材料)の棚卸高 */
export interface InventoryCount {
  year: number;
  amount: number;
}

/** 給与の源泉徴収税額の区分(甲欄/乙欄/丙欄/手入力) */
export type SalaryTableType = 'kou' | 'otsu' | 'hei' | 'manual';

/** 給与の支払い記録(賃金台帳のもとになる)。保存時に取引が自動起票される */
export interface PayrollEntry {
  id: string;
  /** 従業員名 */
  employee: string;
  /** 支払日 YYYY-MM-DD */
  date: string;
  /** 総支給額 */
  gross: number;
  /** 源泉徴収税額(預り金として計上される) */
  withholding: number;
  /** 社会保険料等の天引き額(雇用保険料など。預り金として計上される)。源泉の判定はこの控除後の金額で行う */
  socialInsurance?: number;
  /** 適用した税額区分 */
  table: SalaryTableType;
  note?: string;
  /** 自動起票した取引ID(手取りの支払い・源泉・社会保険料等の預り) */
  linkedTxIds?: string[];
  createdAt: number;
}

/** 年末調整の入力(年 × 従業員ごとに1件)。給与以外の控除は本人の申告書から転記する */
export interface YearEndAdjustment {
  year: number;
  employee: string;
  /** 配偶者控除・扶養控除・障害者控除など人的控除の合計(基礎控除は自動計算) */
  personalDeductions: number;
  /** 生命保険料控除・地震保険料控除の合計(保険料控除申告書の控除額) */
  insuranceDeductions: number;
  /** 給与天引き以外に本人が申告した社会保険料・小規模企業共済等掛金 */
  declaredSocialInsurance: number;
}

/** 取引先(請求書の宛先など)。請求書の保存時に自動登録される */
export interface Partner {
  id: string;
  name: string;
  /** 相手方のインボイス登録番号(仕入先の適格判定のメモ用) */
  invoiceRegNumber: string;
  memo: string;
  createdAt: number;
}

/** 所得税シミュレーション用の所得控除入力(年ごとに1件) */
export interface DeductionEntry {
  year: number;
  /** 社会保険料控除(国民年金・国保など。全額) */
  socialInsurance: number;
  /** 小規模企業共済等掛金控除(iDeCo・共済。全額) */
  mutualAid: number;
  /** 生命保険料控除(計算後の控除額。上限12万円) */
  lifeInsurance: number;
  /** 地震保険料控除(上限5万円) */
  earthquakeInsurance: number;
  /** 支払った医療費(足切りは自動計算) */
  medicalPaid: number;
  /** 医療費のうち保険金などで補填された額 */
  medicalReimbursed: number;
  /** 寄附金(ふるさと納税含む)の支払額 */
  donations: number;
  /** 配偶者(特別)控除額 */
  spouse: number;
  /** 扶養控除額 */
  dependents: number;
  /** その他の控除(寡婦・ひとり親・障害者など) */
  others: number;
  /** 青色申告特別控除(65万/55万/10万) */
  blueDeduction: 650000 | 550000 | 100000;
  /** 源泉徴収税額(請求書の源泉から自動集計できる) */
  withholding: number;
}

export function emptyDeduction(year: number): DeductionEntry {
  return {
    year,
    socialInsurance: 0,
    mutualAid: 0,
    lifeInsurance: 0,
    earthquakeInsurance: 0,
    medicalPaid: 0,
    medicalReimbursed: 0,
    donations: 0,
    spouse: 0,
    dependents: 0,
    others: 0,
    blueDeduction: 650000,
    withholding: 0,
  };
}

/** アプリ全体の永続化データ */
export interface AppData {
  transactions: Transaction[];
  rules: Rule[];
  anbunSettings: AnbunSetting[];
  /** 年ごとの期首残高(貸借対照表用) */
  openingBalances: OpeningBalance[];
  /** 消費税の設定 */
  taxSettings: TaxSettings;
  /** 発行した請求書 */
  invoices: Invoice[];
  /** 請求元(自分)の情報 */
  issuer: IssuerProfile;
  /** 固定資産台帳 */
  assets: FixedAsset[];
  /** 年末棚卸高(年ごとに1件) */
  inventories: InventoryCount[];
  /** 所得控除の入力(年ごとに1件) */
  deductions: DeductionEntry[];
  /** 取引先マスタ */
  partners: Partner[];
  /** 給与の支払い記録(賃金台帳) */
  payrolls: PayrollEntry[];
  /** 年末調整の入力(年 × 従業員ごとに1件) */
  yearEndAdjustments: YearEndAdjustment[];
}

export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}
