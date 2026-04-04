/**
 * 从 samples/*.txt（RTF）解析 ASCII，写回 gallery-storage.js 的 DEFAULT_GALLERY_PHOTOS。
 * 不包含 rex / selfie（二者为绿色 #00ff41，已从内置画廊移除）。
 * 用法：node scripts/build-gallery-defaults.js
 */
const fs = require('fs');
const path = require('path');
const { parseRtfSample } = require('./rtf-sample-to-plain.js');

const root = path.join(__dirname, '..');
const galleryPath = path.join(root, 'gallery-storage.js');

const sheep = parseRtfSample(fs.readFileSync(path.join(root, 'samples/sheep.txt'), 'utf8'));
const car = parseRtfSample(fs.readFileSync(path.join(root, 'samples/car.txt'), 'utf8'));
const et = parseRtfSample(fs.readFileSync(path.join(root, 'samples/et.txt'), 'utf8'));

/** @type {Array<{ascii:string,color:string,time:number,isDefault:boolean}>} */
var defaults = [
  {
    ascii: sheep.ascii,
    color: sheep.colorHex,
    time: 1704067200000,
    isDefault: true
  },
  {
    ascii: car.ascii,
    color: car.colorHex,
    time: 1704153600000,
    isDefault: true
  },
  {
    ascii: et.ascii,
    color: et.colorHex,
    time: 1704326400000,
    isDefault: true
  }
];

/**
 * @param {{ascii:string,color:string,time:number,isDefault:boolean}} p
 * @returns {string}
 */
function photoToJs(p) {
  return (
    '    {\n' +
    "      id: 'builtin_sample_" +
    p.time +
    "',\n" +
    '      ascii: ' +
    JSON.stringify(p.ascii) +
    ',\n' +
    '      color: ' +
    JSON.stringify(p.color) +
    ',\n' +
    '      time: ' +
    p.time +
    ',\n' +
    '      isDefault: ' +
    p.isDefault +
    '\n' +
    '    }'
  );
}

var inner = defaults.map(photoToJs).join(',\n');
var newBlock = '  var DEFAULT_GALLERY_PHOTOS = [\n' + inner + '\n  ];';

var galleryJs = fs.readFileSync(galleryPath, 'utf8');
var replaced = galleryJs.replace(/  var DEFAULT_GALLERY_PHOTOS = \[[\s\S]*?\n  \];/, newBlock);
if (replaced === galleryJs) {
  console.error('build-gallery-defaults: could not find DEFAULT_GALLERY_PHOTOS block');
  process.exit(1);
}
fs.writeFileSync(galleryPath, replaced, 'utf8');
console.log('Updated', galleryPath, '(', defaults.length, 'defaults )');
