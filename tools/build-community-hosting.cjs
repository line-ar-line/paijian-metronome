#!/usr/bin/env node
'use strict';

// Copy only the public community page and its dependencies into a new folder.
// Upload this folder to CloudBase's paijian/ prefix, never the repository root.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output' || !args[1]) {
  console.error('Usage: node tools/build-community-hosting.cjs --output <new-directory>');
  process.exit(1);
}
const output = path.resolve(args[1]);
if (fs.existsSync(output)) {
  console.error('Output directory already exists. Choose a new directory.');
  process.exit(1);
}
const files = [
  'community.html', 'styles.css',
  'community/config.js', 'community/entry.js', 'community/client.js',
  'community/cloudbase-client.js', 'community/community.js', 'community/community.css',
  'vendor/cloudbase.min.js', 'vendor/supabase.min.js'
];
for (const file of files) {
  if (!fs.statSync(path.join(root, file)).isFile()) throw new Error('Missing public asset: ' + file);
}
fs.mkdirSync(output, { recursive: true });
let bytes = 0;
for (const file of files) {
  const target = path.join(output, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, file), target);
  bytes += fs.statSync(target).size;
}
console.log(JSON.stringify({ output, files: files.length, bytes }, null, 2));
