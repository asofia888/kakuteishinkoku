'use client';

import { yen } from '@/lib/format';

/** 月別売上の棒グラフ(SVG・依存ライブラリなし) */
export default function BarChart({ values }: { values: number[] }) {
  const width = 720;
  const height = 200;
  const padX = 8;
  const padBottom = 22;
  const max = Math.max(...values, 1);
  const barSpace = (width - padX * 2) / 12;
  const barWidth = barSpace * 0.62;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full"
      role="img"
      aria-label="月別売上グラフ"
    >
      {values.map((v, i) => {
        const h = Math.round(((height - padBottom - 24) * v) / max);
        const x = padX + i * barSpace + (barSpace - barWidth) / 2;
        const y = height - padBottom - h;
        return (
          <g key={i}>
            <rect
              x={x}
              y={y}
              width={barWidth}
              height={h}
              rx={4}
              className="fill-blue-500"
              opacity={v === 0 ? 0.15 : 0.9}
            >
              <title>{`${i + 1}月: ${yen(v)}`}</title>
            </rect>
            {v > 0 && (
              <text
                x={x + barWidth / 2}
                y={y - 6}
                textAnchor="middle"
                className="fill-slate-500"
                fontSize={10}
              >
                {v >= 10000 ? `${Math.round(v / 10000)}万` : v.toLocaleString()}
              </text>
            )}
            <text
              x={x + barWidth / 2}
              y={height - 6}
              textAnchor="middle"
              className="fill-slate-400"
              fontSize={11}
            >
              {i + 1}月
            </text>
          </g>
        );
      })}
    </svg>
  );
}
