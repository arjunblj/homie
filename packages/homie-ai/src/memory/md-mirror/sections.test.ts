import { describe, expect, test } from 'bun:test';

import { extractMdSection, isEffectivelyEmpty, normalizeMdBody } from './sections.js';

describe('md-mirror/sections', () => {
  test('isEffectivelyEmpty treats blank and (empty) as empty', () => {
    expect(isEffectivelyEmpty('')).toBe(true);
    expect(isEffectivelyEmpty('  ')).toBe(true);
    expect(isEffectivelyEmpty('(empty)')).toBe(true);
    expect(isEffectivelyEmpty(' (empty) ')).toBe(true);
    expect(isEffectivelyEmpty('some text')).toBe(false);
  });

  test('extractMdSection extracts content between ## headers', () => {
    const md = [
      '## Capsule',
      'Human wrote this.',
      '',
      '## CapsuleAuto',
      'Auto generated.',
      '',
      '## Notes',
      'Some notes here.',
    ].join('\n');

    expect(extractMdSection(md, 'Capsule')).toBe('Human wrote this.');
    expect(extractMdSection(md, 'CapsuleAuto')).toBe('Auto generated.');
    expect(extractMdSection(md, 'Notes')).toBe('Some notes here.');
    expect(extractMdSection(md, 'Missing')).toBe('');
  });

  test('extractMdSection does not break on ### subsections', () => {
    const md = ['## Notes', '### Sub heading', 'Content under sub.', '## Next'].join('\n');
    expect(extractMdSection(md, 'Notes')).toBe('### Sub heading\nContent under sub.');
  });

  test('extractMdSection handles CRLF line endings', () => {
    const md = '## Capsule\r\nHello world\r\n## Next\r\n';
    expect(extractMdSection(md, 'Capsule')).toBe('Hello world');
  });

  test('normalizeMdBody trims and adds trailing newline', () => {
    expect(normalizeMdBody('hello')).toBe('hello\n');
    expect(normalizeMdBody('  hello  ')).toBe('hello\n');
    expect(normalizeMdBody('')).toBe('');
    expect(normalizeMdBody('  ')).toBe('');
    expect(normalizeMdBody('a\r\nb')).toBe('a\nb\n');
  });
});
