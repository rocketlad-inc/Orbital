/**
 * Page translation moves React's text nodes; React then removes or
 * inserts relative to a node that is no longer where it left it. That
 * must not throw (prod crash, scope App, 2026-10-02).
 */
import { installTranslateGuard } from '../translateGuard';

beforeAll(() => installTranslateGuard());

/** What Chrome's translator does: wrap a text node in a <font>. */
function translate(text: Text) {
  const font = document.createElement('font');
  text.parentNode!.replaceChild(font, text);
  font.appendChild(text);
}

test('removing a text node the translator has wrapped does not throw', () => {
  const span = document.createElement('span');
  const text = document.createTextNode('Build station');
  span.appendChild(text);
  translate(text);
  expect(() => span.removeChild(text)).not.toThrow();
});

test('inserting before a node the translator has wrapped does not throw', () => {
  const div = document.createElement('div');
  const text = document.createTextNode('Mars');
  div.appendChild(text);
  translate(text);
  expect(() => div.insertBefore(document.createElement('b'), text)).not.toThrow();
});

test('ordinary DOM work is unchanged', () => {
  const div = document.createElement('div');
  const a = document.createElement('a');
  const b = document.createElement('b');
  div.appendChild(a);
  div.insertBefore(b, a);
  expect(Array.from(div.childNodes)).toEqual([b, a]);
  div.removeChild(a);
  expect(Array.from(div.childNodes)).toEqual([b]);
});
