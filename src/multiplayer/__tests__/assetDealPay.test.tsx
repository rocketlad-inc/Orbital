/**
 * Paying for a world or a hull from its offer row.
 *
 * fartmaster, 2026-10-06: "Trading for a planet does not seem to work."
 * The row's "Send a freighter" only ever unloaded a hull that was
 * already parked at the asset. It now sends one, to a place the buyer
 * picks: the asset, or any of the seller's settlements.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AssetDealRow } from '../AssetDealRow';
import type { AssetDealRow as Row } from '../api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const deal = (over: Partial<Row> = {}): Row => ({
  id: 'd1', seller_faction_id: 'f1', buyer_faction_id: 'f0',
  seller_name: 'Tritalowda', buyer_name: 'Me', i_am_seller: false,
  asset_kind: 'settlement', asset_id: 's1', asset_name: 'thomas station', asset_detail: 'Quaoar',
  delivery_body_name: 'Quaoar', delivery_body_id: 'quaoar',
  price_metal: 400, price_credits: 0, paid_metal: 0, paid_credits: 0, status: 'active',
  pay_dests: [{ body_id: 'quaoar', name: 'Quaoar' }, { body_id: 'titan', name: 'Titan' }],
  in_flight: { metal: 0, credits: 0, freighters: 0 },
  ...over,
});

function mount(d: Row) {
  const onPay = jest.fn(async () => true);
  const host = document.createElement('div');
  act(() => {
    createRoot(host).render(
      <AssetDealRow
        deal={d}
        freighters={[{ id: 'sh1', name: 'Mule', where: 'Earth' }]}
        busy={false}
        onRespond={async () => true}
        onPay={onPay}
        onCancel={async () => true}
      />,
    );
  });
  return { host, onPay };
}

const selects = (host: HTMLElement) => Array.from(host.querySelectorAll('select'));
const choose = (el: HTMLSelectElement, value: string) => {
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

test("the buyer picks where to pay: the asset or any of the seller's worlds", () => {
  const { host } = mount(deal());
  const [where] = selects(host);
  expect(Array.from(where.options).map(o => o.textContent)).toEqual([
    'Pay at Quaoar (the asset)', 'Pay at Titan',
  ]);
});

test('sending a freighter passes the chosen destination', () => {
  const { host, onPay } = mount(deal());
  const [where, send] = selects(host);
  choose(where, 'titan');
  choose(send, 'sh1');
  expect(onPay).toHaveBeenCalledWith('d1', 'sh1', 'titan');
});

test("what is already on its way is shown, and a covered price offers no more freighters", () => {
  const { host } = mount(deal({ in_flight: { metal: 400, credits: 0, freighters: 1 } }));
  expect(host.textContent).toContain('1 freighter on the way (400 metal)');
  expect(selects(host)).toHaveLength(0);
});
