// Card 59 M3 (CASE-269): a video block in the shared slide renderer. Its source and poster are browser-local blob:
// handles only; it plays inline; only a phone's has its own controls; before a phone fetches it, its poster plays it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSlide } from '../src/client/slide-render.mjs';
import { imageFigure } from '../src/client/slide-image-render.mjs';

function fakeDoc() {
  const make = tag => ({ tag, attributes: {}, children: [], style: {}, classList: [], setAttribute(name, value) { this.attributes[name] = value; }, append(...nodes) { this.children.push(...nodes); } });
  return { createElement: make, createElementNS: (_, tag) => make(tag), createTextNode: text => ({ text }) };
}
const block = { id: '01a0f4c9-8abb-74fc-aef7-56efce51760f', type: 'image', alt: 'Echo, parasternal long axis', caption: '', fit: 'contain', ecg: null };

test('[AS-168] a released video renders as an inline video from blob: handles; a phone\'s poster plays it when tapped', () => {
  const [figure] = imageFigure(block, () => ({ url: 'blob:video', poster: 'blob:poster', type: 'video/mp4', controls: false, width: 1280, height: 720 }));
  const video = figure.children[0];
  assert.deepEqual([video.tag, video.src, video.poster, video.video.controls, video.attrs['data-video-block']], ['video', 'blob:video', 'blob:poster', false, block.id]);
  const { root } = buildSlide(fakeDoc(), { root: video });
  assert.deepEqual([root.tag, root.src, root.poster, root.controls, root.playsInline, root.preload], ['video', 'blob:video', 'blob:poster', false, true, 'auto']);
  const [phone] = imageFigure(block, () => ({ url: null, poster: 'blob:poster', type: 'video/mp4', controls: true, handle: 'h1', width: 1280, height: 720 }));
  const poster = phone.children[0];
  assert.deepEqual([poster.tag, poster.src, poster.attrs.alt, poster.attrs['data-video-handle']], ['img', 'blob:poster', 'Play video: Echo, parasternal long axis', 'h1']);
  assert.equal(phone.children[1].children[0].children[0].text, 'Tap the picture to play the video');
});

test('[AS-168] a video source or poster that is not a blob: handle is refused', () => {
  for (const item of [{ tag: 'video', src: 'https://example.com/a.mp4' }, { tag: 'video', src: 'blob:x', poster: 'https://example.com/p.jpg' }, { tag: 'div', poster: 'blob:p' }])
    assert.throws(() => buildSlide(fakeDoc(), { root: item }), /slide_source/);
});
