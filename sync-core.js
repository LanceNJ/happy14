/*
 * 三端内核同步 + 校验： game-core.js / advisor.js / sfx.js
 *   root 是唯一真源，electron/src 与 miniprogram/utils 是副本。
 *   默认只校验（报告 MD5 是否一致）；带 --write 才把 root 覆盖到两个副本。
 * 用法： node sync-core.js          仅校验
 *        node sync-core.js --write  同步并校验
 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const ROOT = __dirname;
const FILES = ['game-core.js', 'advisor.js', 'sfx.js'];
const COPIES = [
  (f) => path.join(ROOT, f),
  (f) => path.join(ROOT, 'electron/src', f),
  (f) => path.join(ROOT, 'miniprogram/utils', f),
];

const write = process.argv.includes('--write');
const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex').slice(0, 8);

let bad = 0;
for (const f of FILES) {
  const paths = COPIES.map((fn) => fn(f));
  if (write) {
    const src = paths[0];
    if (!fs.existsSync(src)) { console.log('✗ ' + f + ' 源文件不存在: ' + src); bad++; continue; }
    for (let i = 1; i < paths.length; i++) fs.copyFileSync(src, paths[i]);
    console.log('→ ' + f + ' 已同步到 2 个副本');
  }
  const hashes = paths.map((p) => {
    if (!fs.existsSync(p)) return 'MISSING';
    return md5(p);
  });
  const ok = hashes.every((h) => h === hashes[0] && h !== 'MISSING');
  if (!ok) bad++;
  console.log((ok ? '✓ ' : '✗ ') + f.padEnd(14) +
    ['root', 'electron', 'miniprogram'].map((n, i) => n + '=' + hashes[i]).join('  '));
}
console.log(bad ? '✗ 有 ' + bad + ' 个内核文件未对齐' : '✓ 三端内核全部一致');
process.exit(bad ? 1 : 0);
