// The editor's serialiser is the risky half of a WYSIWYG: contentEditable
// emits whatever the browser feels like, and whatever survives here is
// what gets stored and published. These pin the cases that actually
// happen — messy paste markup, browser-flavoured bold, and figures,
// which must round-trip as empty placeholders and never as their
// rendered contents.

import { serializeForTest as serialize } from '../DevlogRichEditor';

const dom = (html: string) => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
};

describe('devlog editor serialiser', () => {
  it('keeps the tags the server keeps', () => {
    const out = serialize(dom(
      '<h2>Head</h2><p>Body <strong>bold</strong> and <em>it</em>.</p>'
      + '<ul><li>one</li><li>two</li></ul>',
    ));
    expect(out).toContain('<h2>Head</h2>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>it</em>');
    expect(out).toContain('<li>one</li>');
  });

  it('normalises browser bold/italic to the stored spelling', () => {
    const out = serialize(dom('<p><b>x</b> <i>y</i></p>'));
    expect(out).toContain('<strong>x</strong>');
    expect(out).toContain('<em>y</em>');
    expect(out).not.toContain('<b>');
    expect(out).not.toContain('<i>');
  });

  it('unwraps junk but keeps the words', () => {
    // What a paste from a browser or a word processor actually looks like.
    const out = serialize(dom(
      '<div><span style="color:red"><font size="4">kept text</font></span></div>',
    ));
    expect(out).toContain('kept text');
    expect(out).not.toContain('span');
    expect(out).not.toContain('style');
    expect(out).not.toContain('font');
  });

  it('drops attributes entirely', () => {
    const out = serialize(dom('<p class="x" style="color:red" onclick="hack()">t</p>'));
    expect(out).toBe('<p>t</p>');
  });

  it('escapes text that looks like markup', () => {
    const out = serialize(dom('<p>a &lt;script&gt;x&lt;/script&gt; b</p>'));
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;script&gt;');
  });

  it('round-trips a figure as an EMPTY placeholder', () => {
    // The rendered figure is ours, not the author's. If its innards ever
    // leaked into the body, the server would strip them and the post
    // would lose the figure entirely.
    const el = dom('<p>before</p><div class="fig-hit-odds"><svg><rect/></svg>'
      + '<p>chart innards</p></div><p>after</p>');
    const out = serialize(el);
    expect(out).toContain('<div class="fig-hit-odds"></div>');
    expect(out).not.toContain('svg');
    expect(out).not.toContain('chart innards');
    expect(out).toContain('<p>before</p>');
    expect(out).toContain('<p>after</p>');
  });

  it('does not treat an unknown fig-like class as a figure', () => {
    const out = serialize(dom('<div class="fig-not-real">text</div>'));
    expect(out).not.toContain('fig-not-real');
    expect(out).toContain('text');
  });

  it('drops the empty paragraph a stray Enter leaves behind', () => {
    const out = serialize(dom('<p>real</p><p><br></p>'));
    expect(out).toBe('<p>real</p>');
  });

  it('keeps a table intact', () => {
    const out = serialize(dom(
      '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>',
    ));
    expect(out).toContain('<table>');
    expect(out).toContain('<th>A</th>');
    expect(out).toContain('<td>1</td>');
  });
});
