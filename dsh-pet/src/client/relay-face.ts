// 中转站气泡（浏览器 overlay 侧）。
// 与余额气泡共用同一套样式（bubble.ts 的 .dsh-pet-bubble / .pet-bub-row / .pet-bub-sub：
// CSS 由 makeBalanceBubble 的工厂创建时注入，PetCard 一挂载就注）与行渲染口径，
// 同时渲染只会叠在同一坐标互相遮盖——所以气泡是单槽，由 PetCard 按优先级挑一个。
// 内容来自 src/shared/relays.ts 的 relaysBubbleRows（纯函数；桌面端可复用同一份文案）。
import type { jsx } from 'react/jsx-runtime';
import type { ReactNode } from 'react';

import type { BalanceBubbleRow } from '../shared/balance';
import { relaysBubbleRows, type RelaysView } from '../shared/relays';

/**
 * 制造中转站气泡（工厂）。props = { view, on }：
 * - view：readRelays 解析出的舰队视图；
 * - on：显隐（hover 或新告警的 10s 临时显示）。
 */
export function makeRelayBubble(rt: { h: typeof jsx }): (props: { view: RelaysView; on: boolean }) => ReactNode {
  const { h } = rt;
  return function RelayBubble({ view, on }: { view: RelaysView; on: boolean }) {
    const rows: BalanceBubbleRow[] = relaysBubbleRows(view);
    return h('div', {
      className: 'dsh-pet-bubble' + (on ? ' is-on' : ''),
      children: rows.map((r, i) => {
        if (r.role === 'error') return h('div', { key: i, className: 'pet-bub-err', children: r.text });
        if (r.role === 'sub') return h('div', { key: i, className: 'pet-bub-row pet-bub-sub', children: r.text });
        return h('div', { key: i, className: 'pet-bub-row', children: r.text });
      }),
    });
  };
}
