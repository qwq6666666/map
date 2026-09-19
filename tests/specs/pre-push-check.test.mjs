import { describe, test, expect } from 'vitest';
import prePushCheck from '../../tools/pre-push-check.js';

const { pushesToMain } = prePushCheck;
const SHA = 'a'.repeat(40);
const ZERO = '0'.repeat(40);

describe('pre-push-check pushesToMain()', () => {
  test('推送 main → true', () => {
    expect(pushesToMain(`refs/heads/main ${SHA} refs/heads/main ${ZERO}\n`)).toBe(true);
  });

  test('推送其他分支 → false', () => {
    expect(pushesToMain(`refs/heads/dev ${SHA} refs/heads/dev ${ZERO}\n`)).toBe(false);
  });

  test('刪除 main（local sha 全 0）→ false', () => {
    expect(pushesToMain(`(delete) ${ZERO} refs/heads/main ${SHA}\n`)).toBe(false);
  });

  test('同時推多個 ref、其中一個是 main → true', () => {
    const input = `refs/heads/dev ${SHA} refs/heads/dev ${ZERO}\nrefs/heads/main ${SHA} refs/heads/main ${SHA}\n`;
    expect(pushesToMain(input)).toBe(true);
  });

  test('空輸入 → false', () => {
    expect(pushesToMain('')).toBe(false);
  });
});
