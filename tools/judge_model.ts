#!/usr/bin/env node
/** Named metadata inspection entrypoint; never loads model weights. */
import {entry} from './embctl.ts';
await entry(['inspect', ...process.argv.slice(2)]);
