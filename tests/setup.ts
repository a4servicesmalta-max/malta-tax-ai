// Runs before any test module imports src/store. Points persistence at a fresh
// temp dir (never the repo's ./data) and puts the app gate in open mode so the
// functional endpoint tests don't each need a registered+verified user.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'taxgen-test-'));
process.env.TAXGEN_OPEN = '1';
