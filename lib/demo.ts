import { EXCLUDED_ACCOUNT } from './accounts';
import { buildDefaultRules } from './rules';
import { AppData, Transaction, uid } from './types';

/**
 * 動作確認用のサンプルデータ(今年1年分)。
 * 「サンプルデータを読み込む」で既存データを置き換える。
 * 複式簿記・発生主義の主要パターンを一通り含む:
 * 銀行入出金 / カード払い(未払金)とその引落し / 売掛金の計上と回収 / 対象外 / 家事按分
 */
export function buildDemoData(): AppData {
  const year = new Date().getFullYear();
  const txs: Omit<Transaction, 'id' | 'createdAt' | 'businessAmount' | 'anbunApplied'>[] = [];

  /** その月のカード利用額(翌月27日に口座から引き落とされる) */
  const cardSpend = (m: number) => 4200 + (m % 5) * 800;

  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    // 収入: 毎月の報酬 + 不定期案件(銀行振込)
    txs.push({
      date: `${year}-${mm}-25`,
      amount: 320000 + (m % 3) * 40000,
      description: '振込 カブシキガイシャABC ギョウムイタクホウシュウ',
      type: 'income',
      account: 'sales',
      approved: true,
      source: 'demo',
      fund: 'bank',
    });
    if (m % 2 === 0) {
      txs.push({
        date: `${year}-${mm}-10`,
        amount: 88000,
        description: '振込 XYZデザイン 報酬',
        type: 'income',
        account: 'sales',
        approved: true,
        source: 'demo',
        fund: 'bank',
      });
    }
    // 経費: 家賃(按分対象) / 電気(按分対象) / 通信 / 消耗品(カード払い)
    txs.push({
      date: `${year}-${mm}-27`,
      amount: 85000,
      description: '家賃 スミダマンション',
      type: 'expense',
      account: 'rent',
      approved: true,
      source: 'demo',
      fund: 'bank',
    });
    txs.push({
      date: `${year}-${mm}-15`,
      amount: 9800 + (m % 4) * 1200,
      description: 'キュウシュウデンリョク 電気料金',
      type: 'expense',
      account: 'utilities',
      approved: true,
      source: 'demo',
      fund: 'bank',
    });
    txs.push({
      date: `${year}-${mm}-20`,
      amount: 6578,
      description: 'NTT DOCOMO ツウシンリョウ',
      type: 'expense',
      account: 'communication',
      approved: true,
      source: 'demo',
      fund: 'bank',
    });
    // カードで購入 → 未払金に計上され、翌月27日の引落しで消える(発生主義)
    txs.push({
      date: `${year}-${mm}-08`,
      amount: cardSpend(m),
      description: 'AMAZON.CO.JP',
      type: 'expense',
      account: 'supplies',
      approved: m <= 6,
      source: 'demo',
      fund: 'card',
    });
    if (m >= 2) {
      txs.push({
        date: `${year}-${mm}-27`,
        amount: cardSpend(m - 1),
        description: 'ラクテンカードサービス カード利用代金',
        type: 'expense',
        account: 'card_payment', // 経費ではなく未払金の決済(二重計上を防ぐ)
        approved: true,
        source: 'demo',
        fund: 'bank',
      });
    }
  }

  // 発生主義: 12月末に請求した報酬を売掛金として当年の売上に計上
  // (入金は翌年1月のため、期末の貸借対照表に売掛金として残る)
  txs.push({
    date: `${year}-12-31`,
    amount: 220000,
    description: '12月分 業務委託報酬(請求書発行・売掛金計上)',
    type: 'income',
    account: 'sales',
    approved: true,
    source: 'demo',
    fund: 'receivable',
  });

  // 資金移動と現金払い(ATMで事業用現金を用意し、現金で少額経費を払う例)
  txs.push(
    {
      date: `${year}-04-05`,
      amount: 30000,
      description: 'ATM引き出し(事業用現金)',
      type: 'expense',
      account: 'fund_transfer', // 預金 → 現金 の資金移動(損益に影響しない)
      approved: true,
      source: 'demo',
      fund: 'bank',
      counterFund: 'cash',
    },
    {
      date: `${year}-04-18`,
      amount: 3200,
      description: '文具店 コピー用紙・封筒(現金)',
      type: 'expense',
      account: 'supplies',
      approved: true,
      source: 'demo',
      fund: 'cash',
    },
  );

  // 固定資産の取得(経費ではなく資産計上 → 台帳の減価償却で経費化される)
  txs.push({
    date: `${year}-03-10`,
    amount: 150000,
    description: 'ビックカメラ ミラーレスカメラ購入',
    type: 'expense',
    account: 'asset_purchase',
    approved: true,
    source: 'demo',
    fund: 'bank',
  });

  // 未仕訳・対象外のサンプル(ダッシュボードのアラートと「対象外」区分の確認用)
  txs.push(
    {
      date: `${year}-06-14`,
      amount: 12800,
      description: 'ヨドバシカメラ マルチメディアAkiba',
      type: 'expense',
      account: null,
      approved: false,
      source: 'demo',
      fund: 'bank',
    },
    {
      date: `${year}-09-03`,
      amount: 3450,
      description: 'スターバックス コーヒー',
      type: 'expense',
      account: null,
      approved: false,
      source: 'demo',
      fund: 'card',
    },
    {
      date: `${year}-07-19`,
      amount: 8640,
      description: 'マルエツ 食料品',
      type: 'expense',
      account: EXCLUDED_ACCOUNT, // プライベートな支出は「対象外」にすると集計から除外される
      approved: true,
      source: 'demo',
      fund: 'bank',
    },
  );

  const transactions = txs.map((t, i) => ({
    ...t,
    id: uid(),
    createdAt: Date.now() + i,
    businessAmount: t.amount,
    anbunApplied: false,
  }));
  // 12月の売掛計上と対応するサンプル請求書(発行→売掛計上→翌年入金の流れを示す)
  const receivableTx = transactions.find((t) => t.fund === 'receivable');

  return {
    transactions,
    rules: buildDefaultRules(),
    anbunSettings: [
      {
        id: uid(),
        account: 'rent',
        type: 'fixed',
        value: 30000,
        memo: '仕事部屋の床面積 18㎡ / 全体 50㎡ ≒ 家賃85,000円の35%相当',
      },
      {
        id: uid(),
        account: 'utilities',
        type: 'percent',
        value: 40,
        memo: '平日日中の在宅作業時間ベース(週40時間/生活時間)',
      },
      { id: uid(), account: 'communication', type: 'percent', value: 60 },
    ],
    openingBalances: [
      { year, cash: 50000, bank: 800000, receivable: 0, card: 0, payable: 0, deposit: 0 },
    ],
    taxSettings: { taxable: true, method: 'special20', simplifiedType: 5 },
    invoices: [
      {
        id: uid(),
        number: `${year}-012`,
        issueDate: `${year}-12-31`,
        dueDate: `${year + 1}-01-31`,
        client: '株式会社ABC',
        clientSuffix: '御中',
        title: `${year}年12月分 業務委託`,
        items: [
          {
            id: uid(),
            description: 'デザイン制作(12月分)',
            quantity: 1,
            unitPrice: 200000,
            taxRate: 10,
          },
        ],
        taxIncluded: false,
        withholding: false,
        notes: 'いつもお世話になっております。',
        // 12月末の売掛計上済み(取引一覧の売掛金取引に対応)
        ...(receivableTx ? { linkedTxIds: [receivableTx.id] } : {}),
        createdAt: Date.now(),
      },
    ],
    issuer: {
      name: '山田 太郎(ヤマダデザイン)',
      invoiceRegNumber: 'T1234567890123',
      address: '東京都墨田区○○ 1-2-3',
      tel: '090-0000-0000',
      email: 'yamada@example.com',
      bankInfo: '○○銀行 △△支店(普通)1234567 ヤマダ タロウ',
      nameKana: 'ヤマダ タロウ',
      yago: 'ヤマダデザイン',
      shokugyo: 'デザイン業',
      etaxId: '',
      zeimushoCode: '',
      zeimushoName: '',
    },
    assets: [
      {
        id: uid(),
        name: 'ノートPC(MacBook Pro)',
        acquiredDate: `${year - 1}-07-10`,
        cost: 240000,
        method: 'straight',
        usefulLife: 4,
        businessRatio: 100,
        memo: '前年7月取得。定額法4年(償却率0.250)',
        createdAt: Date.now(),
      },
      {
        id: uid(),
        name: 'ミラーレスカメラ',
        acquiredDate: `${year}-03-10`,
        cost: 150000,
        method: 'lump3',
        usefulLife: 5,
        businessRatio: 100,
        memo: '10万〜20万円未満のため一括償却(3年均等)を選択',
        createdAt: Date.now(),
      },
    ],
    inventories: [],
    deductions: [],
    payrolls: [],
    yearEndAdjustments: [],
    partners: [
      {
        id: uid(),
        name: '株式会社ABC',
        invoiceRegNumber: '',
        memo: '毎月の業務委託(25日払い)',
        createdAt: Date.now(),
      },
      { id: uid(), name: 'XYZデザイン', invoiceRegNumber: '', memo: '', createdAt: Date.now() },
    ],
  };
}
