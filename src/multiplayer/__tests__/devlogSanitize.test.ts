// Devlog bodies are stored HTML set with innerHTML on a public page, so
// the sanitiser (worker/devlog.js) is the guard. Links are the one place
// it keeps an attribute: an href to a path on this site, nothing else.
// @ts-ignore — plain JS worker module
import { sanitizeHtml } from '../../../worker/devlog.js';

describe('devlog sanitiser: links', () => {
  it('keeps links to paths on this site', () => {
    expect(sanitizeHtml('<a href="/how-to-play">How to play</a>')).toBe('<a href="/how-to-play">How to play</a>');
    expect(sanitizeHtml("<a href='/devlog/map-maker#routes'>x</a>")).toBe('<a href="/devlog/map-maker#routes">x</a>');
    expect(sanitizeHtml('<a href="/">home</a>')).toBe('<a href="/">home</a>');
  });

  it('drops every other href and every other attribute', () => {
    for (const bad of ['javascript:alert(1)', '//evil.example', 'https://evil.example', 'mailto:x@y.z',
      '/x&quot;onmouseover=alert(1)', '/a b', 'data:text/html,hi', '']) {
      expect(sanitizeHtml(`<a href="${bad}">x</a>`)).toBe('<a>x</a>');
    }
    expect(sanitizeHtml('<a href="/x" onclick="alert(1)" style="color:red">x</a>')).toBe('<a href="/x">x</a>');
    expect(sanitizeHtml('<a onclick="alert(1)">x</a>')).toBe('<a>x</a>');
  });

  it('still strips scripts and unknown tags around links', () => {
    expect(sanitizeHtml('<p><a href="/">ok</a><script>alert(1)</script><img src=x onerror=alert(1)></p>'))
      .toBe('<p><a href="/">ok</a></p>');
  });
});
