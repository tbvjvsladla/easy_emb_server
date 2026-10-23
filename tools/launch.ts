#!/usr/bin/env node
/** Named serving entrypoint for an approved attempt. */
import {entry} from './embctl.ts';
await entry(['serve', ...process.argv.slice(2)]);
