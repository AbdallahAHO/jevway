import { describe, expect, it } from 'vitest';
import { jpegSize } from '../../src/browser/tab.ts';

describe('JPEG size', () => {
  // A 7x3 screenshot from Chrome: an ICC profile segment sits between the file header and the frame header.
  const chromeJpeg =
    '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDACgcHiMeGSgjISMtKygwPGRBPDc3PHtYXUlkkYCZlo+AjIqgtObDoKrarYqMyP/L2u71////m8H////6/+b9//j/2wBDASstLTw1PHZBQXb4pYyl+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj4+Pj/wAARCAADAAcDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJIAP//Z';

  it('reads the width and height of a real screenshot, skipping the segments before its frame', () => {
    expect(jpegSize(chromeJpeg)).toEqual({ width: 7, height: 3 });
  });

  it('reads a frame header that follows fill bytes and a comment segment', () => {
    // SOI, fill bytes, a 4-byte comment segment, then SOF0 (8 bits, height 1536, width 709).
    const bytes = [0xff, 0xd8, 0xff, 0xff, 0xfe, 0x00, 0x04, 0x61, 0x62, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x06, 0x00, 0x02, 0xc5, 0x01];
    expect(jpegSize(Buffer.from(bytes).toString('base64'))).toEqual({ width: 709, height: 1536 });
  });

  it('is null for bytes that are not a JPEG, or a JPEG cut off before its frame', () => {
    expect(jpegSize(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').toString('base64'))).toBeNull();
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64'))).toBeNull();
    expect(jpegSize('')).toBeNull();
  });
});
