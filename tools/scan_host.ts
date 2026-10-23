#!/usr/bin/env node
/** Named initialization entrypoint using the same deterministic CLI. */
import {entry} from './embctl.ts';
await entry(['init', ...process.argv.slice(2)]);
