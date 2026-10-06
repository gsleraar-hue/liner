'use strict';

// Puts a bundled ffmpeg into the packaged app, so nobody has to install it separately.
const path = require('path');
const { Arch } = require('electron-builder');
const { placeFfmpeg } = require('../dev/fetch-ffmpeg');

exports.default = async function afterPack(context) {
  const placed = await placeFfmpeg(path.join(context.appOutDir, 'resources'), context.electronPlatformName, Arch[context.arch]);
  console.log('  • bundled ffmpeg   ' + placed);
};
