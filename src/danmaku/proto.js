// Just enough protobuf decoding for niconico's live comment stream (no schema compiler):
// fields are read by number, nested messages are decoded on demand.

/** Reads a varint at `pos`; returns [value, newPos] (value as a Number, fine below 2^53). */
export function varint(buf, pos) {
  let result = 0;
  let mul = 1;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new RangeError('truncated varint');
    const b = buf[pos++];
    result += (b & 0x7f) * mul;
    if (b < 0x80) return [result, pos];
    mul *= 128;
  }
  throw new RangeError('varint too long');
}

/**
 * Decodes one message into { fieldNumber: [values] }. Length-delimited values are
 * Buffers (strings / nested messages / bytes), varints are Numbers.
 */
export function decode(buf) {
  const fields = {};
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = varint(buf, pos);
    const no = Math.floor(key / 8);
    const type = key & 7;
    let value;
    if (type === 0) {
      [value, pos] = varint(buf, pos);
    } else if (type === 2) {
      let len;
      [len, pos] = varint(buf, pos);
      if (pos + len > buf.length) throw new RangeError('truncated field');
      value = buf.subarray(pos, pos + len);
      pos += len;
    } else if (type === 1) {
      value = buf.subarray(pos, pos + 8);
      pos += 8;
    } else if (type === 5) {
      value = buf.subarray(pos, pos + 4);
      pos += 4;
    } else {
      throw new Error(`unsupported wire type ${type}`);
    }
    (fields[no] ||= []).push(value);
  }
  return fields;
}

export const str = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : v === undefined ? undefined : String(v));
export const first = (fields, no) => fields?.[no]?.[0];
export const sub = (fields, no) => {
  const v = first(fields, no);
  return Buffer.isBuffer(v) ? decode(v) : undefined;
};

/**
 * Splits a stream of length-prefixed messages (varint length + bytes) as data arrives.
 * `push(chunk)` returns the complete messages found so far.
 */
export class LengthDelimited {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out = [];
    for (;;) {
      let len;
      let pos;
      try {
        [len, pos] = varint(this.buf, 0);
      } catch {
        break; // the length itself isn't complete yet
      }
      if (this.buf.length < pos + len) break;
      out.push(this.buf.subarray(pos, pos + len));
      this.buf = this.buf.subarray(pos + len);
    }
    return out;
  }
}
