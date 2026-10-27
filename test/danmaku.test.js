import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';

import { packet, parseXml, roomFromUrl, toComment, unpack, wbiSign } from '../src/danmaku/bilibili.js';
import { chatFromMessage, embeddedData, fromCommands, parseVod } from '../src/danmaku/niconico.js';
import { LengthDelimited, decode } from '../src/danmaku/proto.js';
import { parseLine } from '../src/danmaku/youtube.js';

test('bilibili XML', () => {
  const xml = `<?xml version="1.0"?><i>
    <d p="12.5,1,25,16777215,1,0,abc,1">hello &amp; &lt;world&gt;</d>
    <d p="3.0,5,36,16711680,1,0,abc,2">頂部大字</d>
    <d p="1.0,7,25,0,1,0,abc,3">[advanced]</d>
    <d p="2.0,4,18,65280,1,0,abc,4">底部小字</d></i>`;
  const list = parseXml(xml);
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((c) => c.t), [2, 3, 12.5]);
  assert.deepEqual(list[0], { t: 2, text: '底部小字', mode: 'bottom', color: '#00ff00', size: 'small' });
  assert.equal(list[1].mode, 'top');
  assert.equal(list[1].size, 'big');
  assert.equal(list[1].color, '#ff0000');
  assert.equal(list[2].text, 'hello & <world>');
});

test('bilibili WBI signature (documented example)', () => {
  const q = wbiSign({ foo: '114', bar: '514', zab: 1919810 }, '7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45', 1702204169000);
  assert.equal(q, 'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');
});

test('bilibili live packets', () => {
  const auth = packet(7, { roomid: 1 });
  assert.equal(auth.readUInt32BE(0), auth.length);
  assert.equal(auth.readUInt32BE(8), 7);
  // a brotli (ver 3) message holding two comments
  const inner = Buffer.concat([
    packet(5, { cmd: 'DANMU_MSG', info: [[0, 1, 25, 0xff0000], '第一條', [1, '小明']] }),
    packet(5, { cmd: 'DANMU_MSG:4:0:2:2:2:0', info: [[0, 5, 25, 0xffffff], '頂部', [2, '小華']] }),
  ]);
  const body = zlib.brotliCompressSync(inner);
  const outer = packet(5, '');
  const frame = Buffer.concat([outer.subarray(0, 16), body]);
  frame.writeUInt32BE(frame.length, 0);
  frame.writeUInt16BE(3, 6);
  const msgs = unpack(frame).map((p) => toComment(JSON.parse(p.body.toString())));
  assert.deepEqual(msgs, [
    { text: '第一條', mode: 'scroll', color: '#ff0000', size: 'normal', user: '小明' },
    { text: '頂部', mode: 'top', color: '#ffffff', size: 'normal', user: '小華' },
  ]);
  assert.equal(toComment({ cmd: 'INTERACT_WORD' }), null);
  const sc = toComment({ cmd: 'SUPER_CHAT_MESSAGE', data: { message: '感謝', price: 30, user_info: { uname: 'A' } } });
  assert.equal(sc.paid, '¥30');
  assert.equal(roomFromUrl('https://live.bilibili.com/21452505?spm=1'), 21452505);
  assert.equal(roomFromUrl('https://live.bilibili.com/h5/123'), 123);
});

test('niconico video comments', () => {
  assert.deepEqual(fromCommands(['184', 'ue', 'red', 'big']), { mode: 'top', color: '#ff0000', size: 'big' });
  assert.deepEqual(fromCommands(['shita', '#123abc', 'small']), { mode: 'bottom', color: '#123abc', size: 'small' });
  const list = parseVod(
    JSON.stringify([
      { vposMs: 5000, body: 'b', commands: [] },
      { vposMs: 1000, body: 'a', commands: ['naka', 'cyan2'] },
      { vposMs: 2000, body: 'hidden', commands: [], score: -5000 },
    ]),
  );
  assert.deepEqual(list.map((c) => [c.t, c.text, c.color]), [
    [1, 'a', '#00cccc'],
    [5, 'b', '#ffffff'],
  ]);
});

// protobuf encoding helpers for the test
const vint = (n) => {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
};
const field = (no, v) =>
  typeof v === 'number'
    ? Buffer.concat([vint(no * 8), vint(v)])
    : Buffer.concat([vint(no * 8 + 2), vint(Buffer.byteLength(v)), Buffer.from(v)]);

test('niconico live protobuf', () => {
  const modifier = Buffer.concat([field(1, 2), field(2, 2), field(3, 1)]); // ue, big, red
  const chat = Buffer.concat([field(1, 'こんにちは'), field(2, '名無し'), field(3, 1234), field(7, modifier)]);
  const message = field(1, chat); // NicoliveMessage.chat
  const chunked = Buffer.concat([field(1, field(1, 'id')), field(2, message)]);
  assert.deepEqual(chatFromMessage(decode(chunked)), { text: 'こんにちは', mode: 'top', color: '#ff0000', size: 'big', user: '名無し' });
  // full colour
  const mod2 = field(4, Buffer.concat([field(1, 255), field(2, 128), field(3, 0)]));
  const c2 = decode(field(2, field(20, Buffer.concat([field(1, 'x'), field(7, mod2)]))));
  assert.equal(chatFromMessage(c2).color, '#ff8000');
  // not a chat
  assert.equal(chatFromMessage(decode(field(4, 'state'))), null);
  // length-delimited stream split anywhere
  const one = Buffer.concat([vint(chunked.length), chunked]);
  const stream = Buffer.concat([one, one, one]);
  const split = new LengthDelimited();
  let got = 0;
  for (let i = 0; i < stream.length; i += 7) got += split.push(stream.subarray(i, i + 7)).length;
  assert.equal(got, 3);
  // big varints (ReadyForNext.at is a Unix time)
  assert.equal(decode(field(1, 1793105480))[1][0], 1793105480);
});

test('niconico embedded data', () => {
  const html = '<script id="embedded-data" data-props="{&quot;site&quot;:{&quot;relive&quot;:{&quot;webSocketUrl&quot;:&quot;wss://a.example/x?y=1&amp;z=2&quot;}}}"></script>';
  assert.equal(embeddedData(html).site.relive.webSocketUrl, 'wss://a.example/x?y=1&z=2');
  assert.throws(() => embeddedData('<html></html>'));
});

test('YouTube live chat line', () => {
  const line = JSON.stringify({
    replayChatItemAction: {
      actions: [
        { addChatItemAction: { item: { liveChatTextMessageRenderer: { message: { runs: [{ text: 'hi ' }, { emoji: { shortcuts: [':wave:'] } }] }, authorName: { simpleText: '@someone' } } } } },
        { addChatItemAction: { item: { liveChatPaidMessageRenderer: { message: { runs: [{ text: 'thanks' }] }, authorName: { simpleText: '@fan' }, purchaseAmountText: { simpleText: 'NT$75.00' } } } } },
        { addLiveChatTickerItemAction: {} },
      ],
    },
    isLive: true,
  });
  const out = parseLine(line);
  assert.equal(out.length, 2);
  assert.equal(out[0].text, 'hi :wave:');
  assert.equal(out[0].user, '@someone');
  assert.equal(out[1].paid, 'NT$75.00');
  assert.deepEqual(parseLine('not json'), []);
});
